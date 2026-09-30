import { loadOnnxEmbedder, type Embedder } from './model.js';
import { readVectorIndex, writeVectorIndex } from './cache.js';
import { semanticReadiness } from './ready.js';

/**
 * 可选层的安全外壳。
 *
 * 核心约定：**向量层的任何故障都不能变成命令失败**。
 * 模型没 pull、索引没 build、`onnxruntime-node` 没装（它是 optionalDependency）、
 * 原生二进制在这台机器上加载不了、ONNX 会话建不起来——统统降级为「这次不用语义」，
 * 词法结果照常给出，并把原因说出来（少召回而不吭声是最坏的失败模式）。
 */
export type SemanticAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export async function attemptSemantic<T>(
  load: () => Promise<Embedder>,
  run: (embedder: Embedder) => Promise<T>,
): Promise<SemanticAttempt<T>> {
  let embedder: Embedder;
  try {
    embedder = await load();
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  try {
    return { ok: true, value: await run(embedder) };
  } catch (e) {
    return { ok: false, reason: message(e) };
  } finally {
    try {
      await embedder.dispose();
    } catch {
      /* 释放失败不该影响已经拿到的结果 */
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ───────────────────── 向量索引保鲜 ───────────────────── */

/**
 * 内联补齐的上限：`new`/`edit` 之后顺手补几个新节点是几十毫秒的事，
 * 但落后太多时（比如先攒了两百个节点才 pull 模型）那是 `practi embed build` 的活，
 * 不能让记录动作变成几秒的等待。
 */
const INLINE_LIMIT = 32;

export type RefreshResult =
  | { state: 'off' }                                   // 没启用（没模型/没索引）：静默
  | { state: 'up-to-date' }
  | { state: 'embedded'; embedded: number; total: number }
  | { state: 'behind'; missing: number }                // 落后太多，交给 embed build
  | { state: 'unavailable'; reason: string };           // 启用了但这次跑不起来

/**
 * 补齐决策（纯函数，便于测试）：给定现有索引与工作区全量哈希，决定这次该做什么。
 *  - off：没有索引（用户没启用向量层）
 *  - up-to-date：一个不缺
 *  - inline：缺几个，顺手补上
 *  - behind：缺太多，交给 `practi embed build`（记录动作不该变成几秒的等待）
 */
export interface RefreshPlan {
  action: 'off' | 'up-to-date' | 'inline' | 'behind';
  missing: string[];
  /** 索引里有、工作区已删的条目数（要顺手清掉） */
  stale: number;
}

export function planRefresh(
  index: { hashes: readonly string[]; rowOf: ReadonlyMap<string, number> } | null,
  allHashes: readonly string[],
  inlineLimit = INLINE_LIMIT,
): RefreshPlan {
  if (index === null) return { action: 'off', missing: [], stale: 0 };
  const known = new Set(allHashes);
  const missing = allHashes.filter((h) => !index.rowOf.has(h));
  const stale = index.hashes.reduce((n, h) => n + (known.has(h) ? 0 : 1), 0);
  if (missing.length === 0 && stale === 0) return { action: 'up-to-date', missing, stale };
  if (missing.length > inlineLimit) return { action: 'behind', missing, stale };
  return { action: 'inline', missing, stale };
}

/**
 * 把工作区里**还没有向量**的节点补上，写回同一个指纹桶。
 *
 * 只在已经启用（模型与索引都在）时做事：没启用就直接返回 'off'，
 * 一次网络、一次原生调用都不发生——记录动作不该因为可选层而变慢或变脆。
 *
 * `load` 可注入，只为测试能在没有 24MB 模型的情况下驱动这条路径。
 */
export async function refreshVectors(
  dataDir: string,
  allHashes: readonly string[],
  textOf: (hash: string) => string,
  load: () => Promise<Embedder> = () => loadOnnxEmbedder(dataDir),
): Promise<RefreshResult> {
  const readiness = semanticReadiness(dataDir);
  if (!readiness.ready) return { state: 'off' }; // 没 pull 过模型 = 用户没选这条路
  const index = readVectorIndex(dataDir, readiness.fingerprint);
  const plan = planRefresh(index, allHashes);
  if (plan.action === 'off' || plan.action === 'up-to-date') return { state: 'up-to-date' };
  if (plan.action === 'behind') return { state: 'behind', missing: plan.missing.length };

  const attempt = await attemptSemantic(load, async (embedder) => {
    const dim = embedder.dim;
    const hashes: string[] = [];
    const vectors = new Float32Array((index!.count - plan.stale + plan.missing.length) * dim);
    const known = new Set(allHashes);
    let row = 0;
    // 先搬旧的（丢掉已不在工作区的）
    for (let i = 0; i < index!.count; i++) {
      const h = index!.hashes[i];
      if (!known.has(h)) continue;
      hashes.push(h);
      vectors.set(index!.vectors.subarray(i * dim, i * dim + dim), row * dim);
      row++;
    }
    // 再补新的
    const fresh = await embedder.embed(plan.missing.map(textOf));
    plan.missing.forEach((h, k) => {
      hashes.push(h);
      vectors.set(fresh[k].subarray(0, dim), row * dim);
      row++;
    });
    // 保持哈希升序：文件内容与行序都确定，两次构建逐字节一致
    const order = hashes.map((h, i) => [h, i] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const sortedHashes = order.map(([h]) => h);
    const sorted = new Float32Array(order.length * dim);
    order.forEach(([, from], to) => sorted.set(vectors.subarray(from * dim, from * dim + dim), to * dim));
    writeVectorIndex(dataDir, {
      fingerprint: index!.fingerprint,
      model: index!.model,
      dim,
      pooling: index!.pooling,
      count: sortedHashes.length,
      hashes: sortedHashes,
      vectors: sorted,
    });
    return { embedded: plan.missing.length, total: sortedHashes.length };
  });
  if (!attempt.ok) return { state: 'unavailable', reason: attempt.reason };
  if (attempt.value.embedded === 0) return { state: 'up-to-date' };
  return { state: 'embedded', embedded: attempt.value.embedded, total: attempt.value.total };
}

/**
 * 把刷新结果变成一行提示；返回 null 表示「不用说话」。
 *
 * 成功时**刻意静默**：每记一条就报一次「我干完活了」是噪音（W_* 的阈值就是按
 * 「不做会被学会无视的提示」校准的）；覆盖率随时可用 `practi embed status` 查。
 * 只在**需要你动手**（落后太多）或**出了故障**（运行时跑不起来）时说话。
 */
export function describeRefresh(r: RefreshResult): string | null {
  switch (r.state) {
    case 'behind':
      return `vectors: ${r.missing} node(s) behind — run \`practi embed build\` when convenient`;
    case 'unavailable':
      return `vectors: not refreshed (${r.reason}) — lexical search is unaffected`;
    default:
      return null; // off / up-to-date / embedded：可选层不在记录流程里刷存在感
  }
}
