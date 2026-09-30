import { resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';
import { computeOwnership } from '../ownership.js';
import { nodeIndexFields, similarDocs, subtreeHashes, subtreeIndexFields } from '../retrieval.js';

export interface SimilarOpts {
  dataDir?: string;
  /** 节点引用（全哈希或 ≥4 位唯一前缀） */
  ref: string;
  limit: number;
  json: boolean;
}

interface SimilarRow {
  hash: string;
  type: string;
  op?: string;
  name: string;
  score: number;
  shared: string[];
  direct: boolean;
  roots: { hash: string; name: string }[];
  size?: number;
  orphan?: boolean;
}

/**
 * practi similar <hash>：按**内容**找近邻（同一主题的不同措辞）。
 *
 * 与 search 的分工：search 是你记得某个词、要把它找回来；similar 是你已拿着一个
 * 节点、想知道「还有谁在讲同一件事」——中文没有分词，换个说法子串就搜不到，这一
 * 条补的正是那个短板。
 *
 * 边界（help 里也写明）：纯字面近邻（字符 bigram + 拉丁词的 tf-idf 余弦），
 * **不做语义理解**；零依赖、全本地、输出确定。目标文本取整棵子树聚合并排除自身
 * 子树——practice 的根往往只有一句话，信息在步骤里。
 */
export function runSimilar(opts: SimilarOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  const root = resolveNodeRef(ws, opts.ref); // 不存在/前缀歧义 → E_NOT_FOUND / E_AMBIGUOUS
  const state = loadState(dataDir);
  const own = computeOwnership(ws, state.direct);
  const node = ws.nodes.get(root)!;

  const target = subtreeIndexFields(root, ws.nodes);
  const exclude = subtreeHashes(root, ws.nodes);
  // 全量节点（哈希升序 → 索引与结果确定），含 indirect 与孤儿
  const docs = [...ws.nodes.keys()].sort().map(h => nodeIndexFields(h, ws.nodes.get(h)!));
  const hits = similarDocs(docs, target, exclude, opts.limit);

  const rows: SimilarRow[] = hits.map((hit) => {
    const n = ws.nodes.get(hit.hash)!;
    const roots = (own.owner.get(hit.hash) ?? []).filter((r) => r !== hit.hash)
      .map((r) => ({ hash: r, name: ws.nodes.get(r)?.name ?? r }));
    return {
      hash: hit.hash,
      type: n.type,
      ...(n.type === 'practice' ? { op: n.op } : {}),
      name: n.name,
      score: hit.score,
      shared: hit.shared,
      direct: own.directSet.has(hit.hash),
      roots,
      ...(own.size.has(hit.hash) ? { size: own.size.get(hit.hash) } : {}),
      ...(!own.directSet.has(hit.hash) && roots.length === 0 ? { orphan: true } : {}),
    };
  });

  const top = rows[0]?.score ?? 0;
  const pct = (s: number): number => (top > 0 ? Math.round((s / top) * 100) : 0);

  if (opts.json) {
    console.log(JSON.stringify({
      target: {
        hash: root,
        type: node.type,
        ...(node.type === 'practice' ? { op: node.op } : {}),
        name: node.name,
        nodes: exclude.size,
      },
      // score 是绝对比例（1.0 = 内容完全相同，跨节点可比）；scorePct 是同一次结果内的相对刻度
      results: rows.map((r) => ({ ...r, scorePct: pct(r.score) })),
      total: rows.length,
    }, null, 2));
    return 0;
  }

  const tag = node.type === 'practice' ? `practice·${node.op}` : 'action';
  console.log(`similar to ${shortHash(root)}  [${tag}]  ${node.name}  (${exclude.size} node(s) in this subtree)`);
  if (rows.length === 0) {
    console.log('\nno similar nodes');
    return 0;
  }
  console.log('');
  for (const row of rows) {
    const rowTag = row.type === 'practice' ? `[practice·${row.op}]` : '[action]';
    const where = row.direct
      ? `direct root, ${row.size} nodes`
      : row.orphan === true
        ? 'orphan (not reachable from any direct POP)'
        : row.roots.map((r) => `in ${shortHash(r.hash)} (${r.name})`).join('; ');
    console.log(`  ${shortHash(row.hash)}  ${rowTag}  ${row.name}`);
    console.log(`    ${String(pct(row.score)).padStart(3)}%  ·  ${where}  ·  shared: ${row.shared.join(', ') || '—'}`);
  }
  console.log(`\n${rows.length} similar node(s) — literal (character-bigram) neighbours only, no semantics`);
  console.log('% is relative to the closest hit; --json also carries the absolute score (1.0 = identical content)');
  return 0;
}
