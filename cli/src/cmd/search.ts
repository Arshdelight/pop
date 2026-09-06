import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';

export interface SearchOpts {
  dataDir?: string;
  positional: string[]; // 查询词（多个 positional 以空格连接，免引号）
  limit: number;
  json: boolean;
}

interface LocalHit {
  hash: string;
  type: string;
  op?: string;
  name: string;
  direct: boolean;
  roots: { hash: string; name: string }[]; // 所属 direct 根（命中节点本身是 direct 时为空）
  size?: number; // 仅 direct 命中：该树的节点数（含共享子树）
}

/**
 * practi search <query...>：本地工作区检索。
 * - 遍历全部已存节点（含 indirect），对 name/description/content 做大小写不敏感子串匹配；
 * - 纯 hex 查询词（≥4 位）额外按哈希前缀匹配；
 * - 空查询 = 浏览：列 direct 根（带各树节点数）。
 */
export function runSearch(opts: SearchOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const q = opts.positional.join(' ').trim();

  const { hits, nodesCount } = collectLocal(dataDir, q);
  const shown = hits.slice(0, opts.limit);
  if (opts.json) {
    console.log(JSON.stringify({ query: q, results: shown, total: hits.length }, null, 2));
    return 0;
  }
  if (hits.length === 0) {
    console.log(q ? `no local matches for "${q}"` : '(no direct pops in this workspace)');
    return 0;
  }
  for (const hit of shown) printLocalHit(hit);
  const label = q ? `${shown.length} matched` : `${shown.length} direct POP(s), ${nodesCount} nodes`;
  console.log(`\n${label} (local workspace) — inspect with \`practi show <hash>\``);
  return 0;
}

function printLocalHit(hit: LocalHit): void {
  const tag = hit.type === 'practice' ? `[practice·${hit.op}]` : '[action]';
  const where = hit.direct
    ? `direct root, ${hit.size} nodes`
    : hit.roots.map((r) => `in ${shortHash(r.hash)} (${r.name})`).join('; ');
  console.log(`  ${shortHash(hit.hash)}  ${tag}  ${hit.name}`);
  console.log(`    ${where}`);
}

/** 本地命中计算：
 *  - 遍历全部已存节点（含 indirect），对 name/description/content 做大小写不敏感子串匹配；
 *    纯 hex 查询词（≥4 位）额外按哈希前缀匹配。
 *  - 输出按 direct 树的深度优先步骤顺序排列，共享子树只出现一次并标注全部所属根。
 *  - 空查询 = 浏览 direct 根（带各树节点数）。 */
function collectLocal(dataDir: string, q: string): { hits: LocalHit[]; nodesCount: number } {
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);
  const direct = state.direct.filter(h => ws.nodes.has(h));
  const directSet = new Set(direct);

  // 包含关系：节点 → 所属 direct 根（共享子树可属多个根）；根 → 树内节点数
  const owner = new Map<string, string[]>();
  const size = new Map<string, number>();
  for (const root of direct) {
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      const list = owner.get(h) ?? [];
      if (!list.includes(root)) list.push(root);
      owner.set(h, list);
      const n = ws.nodes.get(h);
      if (n?.type === 'practice') for (const c of n.children) stack.push(c.hash);
    }
    size.set(root, seen.size);
  }

  const needle = q.toLowerCase();
  const hits: LocalHit[] = [];
  const emitted = new Set<string>();
  const visit = (h: string): void => {
    if (emitted.has(h)) return;
    emitted.add(h);
    const n = ws.nodes.get(h);
    if (!n) return;
    const text = `${n.name}\n${n.description ?? ''}\n${n.content ?? ''}`.toLowerCase();
    const hashHit = /^[0-9a-f]{4,64}$/.test(needle) && h.startsWith(`sha256:${needle}`);
    const matched = !needle || text.includes(needle) || hashHit;
    if (matched && (needle !== '' || directSet.has(h))) {
      hits.push({
        hash: h,
        type: n.type,
        ...(n.type === 'practice' ? { op: n.op } : {}),
        name: n.name,
        direct: directSet.has(h),
        roots: (owner.get(h) ?? []).filter((r) => r !== h).map((r) => ({ hash: r, name: ws.nodes.get(r)?.name ?? r })),
        ...(size.has(h) ? { size: size.get(h) } : {}),
      });
    }
    if (n.type === 'practice') for (const c of n.children) visit(c.hash);
  };
  for (const root of direct) visit(root);

  return { hits, nodesCount: ws.nodes.size };
}
