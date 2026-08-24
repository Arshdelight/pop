import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';

export interface SearchOpts {
  dataDir?: string;
  positional: string[]; // 查询词（多个 positional 以空格连接，免引号）
  scope: string; // public | me | all（仅远端）
  limit: number;
  json: boolean;
  local: boolean; // --local：搜本地工作区（全部已存节点，含 indirect）
}

interface SearchRow {
  root_hash: string;
  name: string;
  description: string | null;
  status: string;
  authorName?: string | null; // 旧 hub 返回；新 hub 不再公开作者署名（认领 ≠ 作者）
  created_at: string;
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
 * pop search <query...>：在 remote 上检索 POP（GET /api/v1/pop/search）。
 * - 标题与内容都参与匹配，标题命中优先（服务端排序）。
 * - --scope public=公开库（默认，仅 PUBLISHED）；me=自己 direct 认领（全状态）；all=并集。
 * - 空 q（`pop search`）返回最近文档，可当浏览用。
 */
export async function runSearch(opts: SearchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const q = opts.positional.join(' ').trim();
  if (opts.local) return runLocalSearch(opts, dataDir, q);

  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  if (!['public', 'me', 'all'].includes(opts.scope)) {
    console.error("error: invalid scope — expected public | me | all");
    return 1;
  }

  const params = new URLSearchParams({ q, scope: opts.scope, limit: String(opts.limit) });
  const res = await authedFetch(dataDir, state.remote.url, `/api/v1/pop/search?${params.toString()}`);
  const body = (await res.json().catch(() => ({}))) as {
    results?: SearchRow[];
    total?: number;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`search failed: ${detail}`);
    return 1;
  }

  const results = body.results ?? [];
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (results.length === 0) {
    console.log(q ? `no results for "${q}" (scope: ${opts.scope})` : `no documents yet (scope: ${opts.scope})`);
    return 0;
  }
  for (const r of results) {
    const desc = r.description ? ` — ${r.description}` : '';
    const author = r.authorName ? `  @${r.authorName}` : '';
    console.log(`  ${shortHash(r.root_hash)}  [${r.status}]  ${r.name}${desc}${author}`);
    console.log(`    ${r.root_hash}`);
  }
  console.log(`\n${results.length} shown (total ${body.total ?? results.length}, scope: ${opts.scope}) — fetch one with \`pop pull <hash>\``);
  return 0;
}

/**
 * --local：本地工作区检索，不碰 remote。
 * - 遍历全部已存节点（含 indirect），对 name/description/content 做大小写不敏感子串匹配；
 *   纯 hex 查询词（≥4 位）额外按哈希前缀匹配。
 * - 输出按 direct 树的深度优先步骤顺序排列，共享子树只出现一次并标注全部所属根。
 * - 空查询 = 浏览 direct 根（带各树节点数）；--limit 同样生效。
 */
function runLocalSearch(opts: SearchOpts, dataDir: string, q: string): number {
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);
  const direct = state.direct.filter((h) => ws.nodes.has(h));
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

  const total = hits.length;
  const shown = hits.slice(0, opts.limit);
  if (opts.json) {
    console.log(JSON.stringify({ query: q, local: true, results: shown, total }, null, 2));
    return 0;
  }
  if (total === 0) {
    console.log(needle ? `no local matches for "${q}"` : '(no direct pops in this workspace)');
    return 0;
  }
  for (const hit of shown) {
    const tag = hit.type === 'practice' ? `[practice·${hit.op}]` : '[action]';
    const where = hit.direct
      ? `direct root, ${hit.size} nodes`
      : hit.roots.map((r) => `in ${shortHash(r.hash)} (${r.name})`).join('; ');
    console.log(`  ${shortHash(hit.hash)}  ${tag}  ${hit.name}`);
    console.log(`    ${where}`);
  }
  const label = needle ? `${shown.length} matched` : `${shown.length} direct pop(s), ${ws.nodes.size} nodes`;
  console.log(`\n${label} (local workspace) — inspect with \`pop show <hash>\``);
  return 0;
}
