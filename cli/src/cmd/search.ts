import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';
import { computeOwnership } from '../ownership.js';
import { notesByNode } from '../notes.js';
import { loadOnnxEmbedder } from '../embed/model.js';
import { rankByVector, readVectorIndex } from '../embed/cache.js';
import { semanticReadiness } from './embed.js';
import {
  fuseRankings,
  nodeIndexFields,
  parseQuery,
  searchDocs,
  type DocEntry,
  type FieldName,
} from '../retrieval.js';

export interface SearchOpts {
  dataDir?: string;
  positional: string[]; // 查询词；多词 = AND（见 help），带引号可传整串
  limit: number;
  json: boolean;
  /** 把本地笔记（notes.json）一并纳入索引文本；默认关，避免改变既有命中集合 */
  notes: boolean;
  /** 语义召回（RRF 融合词法榜与向量榜）；默认关，且需要先 embed pull/build */
  semantic: boolean;
}

interface LocalHit {
  hash: string;
  type: string;
  op?: string;
  name: string;
  direct: boolean;
  /** 所属 direct 根（命中节点本身是 direct 时为空） */
  roots: { hash: string; name: string }[];
  /** 仅 direct 命中：该树的节点数（children 闭包，不含流引用的外部节点） */
  size?: number;
  /** 检索期派生的相关度（不写回节点）；纯语义命中没有 */
  score?: number;
  /** 命中字段；纯语义命中没有 */
  matchedIn?: FieldName[];
  /** 余弦相似度（仅在 --semantic 下且该节点有向量时） */
  vectorScore?: number;
  /** 词法榜没收录、只靠向量进榜 */
  semanticOnly?: boolean;
  /** 非 direct、且不从任何 direct 根可达（如校验失败只落盘未登记的节点） */
  orphan?: boolean;
}

/**
 * practi search <query...>：本地工作区检索。
 * - **遍历工作区全部已存节点**（含 indirect、含被 inputs.from 引用却不作为 children 的节点、
 *   含已不挂在任何 direct 树下的孤儿）——旧版只从 direct 树沿 children 递归，这两类永远搜不到；
 * - 索引文本 = name / description / content / declared inputs+outputs / loop 散文 / op，
 *   纯 hex 查询词（≥4 位）额外按哈希前缀匹配（索引为检索期派生，不进节点哈希）；
 * - 多词 = AND，支持 field: 限定；结果按 title-first 打分排序并标注命中字段；
 * - 空查询 = 浏览 direct 根（带各树节点数）。
 */
export async function runSearch(opts: SearchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const query = parseQuery(opts.positional);

  const { hits, nodesCount, mode, semanticNote } = await collectLocal(dataDir, opts.positional, opts.notes, opts.semantic);
  const shown = hits.slice(0, opts.limit);
  if (opts.json) {
    console.log(JSON.stringify({ query: query.raw, mode, results: shown, total: hits.length }, null, 2));
    if (semanticNote !== undefined) console.error(`note: ${semanticNote}`);
    return 0;
  }
  if (semanticNote !== undefined) console.error(`note: ${semanticNote}`);
  if (hits.length === 0) {
    if (query.raw === '') {
      console.log('(no direct pops in this workspace)');
      return 0;
    }
    console.log(`no local matches for "${query.raw}"`);
    // 实测结论（772 节点真实语料）：换个说法的查询在词法层是**结构性**搜不到的
    // ——不是调参能救的（7 条真·改写查询 0 命中），所以这里给的是下一步动作，
    // 而不是一句死路。这也是为什么 CLI 不假装懂语义：假装的结果是自信的错误。
    console.log('  this search is literal (character bigram) — a paraphrase sharing no wording cannot match.');
    console.log('  next:');
    console.log(`    practi search ${opts.positional.join(' ')} --notes   # your notes use your own words`);
    console.log(`    practi search ${opts.positional.join(' ')} --semantic   # vector recall, if you pulled the model`);
    console.log('    practi similar <hash>              # start from a node you do have, find what is like it');
    console.log('    practi ls                          # browse the direct pops by name');
    return 0;
  }
  if (mode === 'browse') {
    for (const hit of shown) printBrowseHit(hit);
    console.log(`\n${shown.length} direct POP(s), ${nodesCount} nodes (local workspace) — inspect with \`practi show <hash>\``);
    return 0;
  }
  for (const hit of shown) printLocalHit(hit, mode === 'or');
  const relaxed = mode === 'or' ? '  (relaxed: partial match — not every term was required)' : '';
  const semantic = hits.some(h => h.vectorScore !== undefined) ? '  (fused with vector recall)' : '';
  const more = hits.length > shown.length ? ` of ${hits.length}` : '';
  console.log(`\n${shown.length}${more} matched (local workspace)${relaxed}${semantic} — inspect with \`practi show <hash>\``);
  return 0;
}

function printBrowseHit(hit: LocalHit): void {
  const tag = hit.type === 'practice' ? `[practice·${hit.op}]` : '[action]';
  console.log(`  ${shortHash(hit.hash)}  ${tag}  ${hit.name}`);
  console.log(`    direct root, ${hit.size} nodes`);
}

function printLocalHit(hit: LocalHit, partial: boolean): void {
  const tag = hit.type === 'practice' ? `[practice·${hit.op}]` : '[action]';
  const where = hit.direct
    ? `direct root, ${hit.size} nodes`
    : hit.orphan === true
      ? 'orphan (not reachable from any direct POP)'
      : hit.roots.map((r) => `in ${shortHash(r.hash)} (${r.name})`).join('; ');
  const why = hit.matchedIn !== undefined && hit.matchedIn.length > 0
    ? hit.matchedIn.join(', ')
    : (hit.semanticOnly === true ? 'semantic' : '—');
  // 放宽出来的一行必须自己带上「这不是全中」的标记：分数与标题命中看起来一样权威，
  // 不标就会被当成答案（实测过：OR 档把完全无关的实践排到第一）
  const mark = partial ? 'partial match — only part of the query hit' : '';
  const cos = hit.vectorScore !== undefined ? `  ·  cos ${hit.vectorScore.toFixed(3)}` : '';
  const score = hit.score !== undefined ? `  ·  score ${hit.score}` : '';
  console.log(`  ${shortHash(hit.hash)}  ${tag}  ${hit.name}`);
  console.log(`    ← ${why}${mark === '' ? '' : `  ·  ${mark}`}  ·  ${where}${cos}${score}`);
}

/**
 * 本地命中计算。两件事刻意分开做，不合并成一个循环：
 *  1. **归属**：只从 direct 根出发，算 owner / depth / size——用于展示「这是谁家的第几步」。
 *  2. **匹配**：遍历 ws.nodes 全量节点打分——用于召回。匹配集合与归属互不影响。
 */
async function collectLocal(
  dataDir: string,
  positional: string[],
  withNotes: boolean,
  semantic: boolean,
): Promise<{ hits: LocalHit[]; nodesCount: number; mode: 'browse' | 'and' | 'or'; semanticNote?: string }> {
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);
  // ── 1. 归属与规模（只从 direct 走）── 与 similar 共用同一份可达性判定
  const { owner, depthOf, size, direct, directSet } = computeOwnership(ws, state.direct);

  const decorate = (hash: string, extra: { score?: number; matchedIn?: FieldName[] } = {}): LocalHit => {
    const n = ws.nodes.get(hash)!;
    const roots = (owner.get(hash) ?? []).filter((r) => r !== hash)
      .map((r) => ({ hash: r, name: ws.nodes.get(r)?.name ?? r }));
    return {
      hash,
      type: n.type,
      ...(n.type === 'practice' ? { op: n.op } : {}),
      name: n.name,
      direct: directSet.has(hash),
      roots,
      ...(size.has(hash) ? { size: size.get(hash) } : {}),
      ...extra,
      ...(!directSet.has(hash) && roots.length === 0 ? { orphan: true } : {}),
    };
  };

  // ── 2. 匹配：全量节点（哈希升序 → 结果与索引都确定）─────────────────
  if (positional.every(w => w.trim() === '')) {
    return {
      hits: direct.map(h => decorate(h)),
      nodesCount: ws.nodes.size,
      mode: 'browse',
    };
  }

  // 笔记是 sidecar，默认不进索引（不改变既有命中集合）；--notes 打开后按节点并入。
  // 笔记里往往写着最口语、最可能被想起来的词——正是零碎实践最该被搜到的地方。
  const notes = withNotes ? notesByNode(dataDir) : new Map<string, string>();
  const docs: DocEntry[] = [...ws.nodes.keys()].sort()
    .map(h => nodeIndexFields(h, ws.nodes.get(h)!, withNotes ? notes.get(h) : undefined));
  const { hits: scored, mode } = searchDocs(docs, parseQuery(positional), { directSet, depthOf });
  const lexicalHits = scored.map(s => decorate(s.hash, { score: s.score, matchedIn: s.matchedIn }));
  if (!semantic) return { hits: lexicalHits, nodesCount: ws.nodes.size, mode };

  // ── 3. 语义召回（可选层）：只加不减 —— 词法榜原样保留，向量榜并进来做 RRF 融合
  const sem = await semanticRanking(dataDir, positional, docs);
  if (!sem.ready) {
    return { hits: lexicalHits, nodesCount: ws.nodes.size, mode, semanticNote: `--semantic ignored: ${sem.reason}` };
  }
  const lexicalOrder = lexicalHits.map(h => h.hash);
  const fused = fuseRankings([lexicalOrder, sem.order], 60);
  const byHash = new Map(lexicalHits.map(h => [h.hash, h]));
  const cos = new Map(sem.order.map((h, i) => [h, sem.scores[i]]));
  const hits = fused.map((hash) => {
    const lexical = byHash.get(hash);
    const vectorScore = cos.get(hash);
    if (lexical !== undefined) return { ...lexical, ...(vectorScore !== undefined ? { vectorScore } : {}) };
    return {
      ...decorate(hash, {}),
      ...(vectorScore !== undefined ? { vectorScore } : {}),
      semanticOnly: true,
    };
  });
  return {
    hits,
    nodesCount: ws.nodes.size,
    // 融合后「放宽」不再描述结果集：向量榜本来就允许部分命中
    mode: hits.length > 0 && lexicalHits.length === 0 ? 'and' : mode,
    ...(sem.covered < ws.nodes.size
      ? { semanticNote: `vector index covers ${sem.covered}/${ws.nodes.size} node(s) — run \`practi embed build\` to refresh` }
      : {}),
  };
}

/**
 * 语义榜：把查询向量与全库向量比一遍，返回**降序的哈希表 + 对应余弦**。
 *
 * 返回缺口而不是抛错：语义是可选层，缺模型时词法结果照常给出，只是附一句
 * 「--semantic 被忽略了，因为……」，绝不悄悄少召回（少召回而无声是这类功能最坏的失败模式）。
 */
async function semanticRanking(
  dataDir: string,
  positional: readonly string[],
  docs: readonly DocEntry[],
): Promise<{ ready: true; order: string[]; scores: number[]; covered: number } | { ready: false; reason: string }> {
  const readiness = semanticReadiness(dataDir);
  if (!readiness.ready) return { ready: false, reason: readiness.reason };
  const index = readVectorIndex(dataDir, readiness.fingerprint);
  if (index === null) return { ready: false, reason: 'vector index missing (run `practi embed build`)' };
  const embedder = await loadOnnxEmbedder(dataDir);
  try {
    const [qv] = await embedder.embed([embedder.queryPrefix + positional.join(' ').trim()]);
    const ranked = rankByVector(index, qv);
    const known = new Set(docs.map(d => d.hash));
    const order: string[] = [];
    const scores: number[] = [];
    for (const r of ranked) {
      if (!known.has(r.hash)) continue; // 索引里有、工作区已删：不进榜
      order.push(r.hash);
      scores.push(r.score);
      if (order.length >= 200) break; // 只让前 200 参与融合，避免长尾把 RRF 摊平
    }
    return { ready: true, order, scores, covered: order.length };
  } finally {
    await embedder.dispose();
  }
}
