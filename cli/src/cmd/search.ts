import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch, requireCredentials } from '../client.js';
import { shortHash } from '../render.js';

export interface SearchOpts {
  dataDir?: string;
  positional: string[]; // 查询词（多个 positional 以空格连接，免引号）
  scope: string; // public | me | all（远端半场；本地无此概念）
  limit: number;
  json: boolean;
  local: boolean; // --local：只搜本地工作区（全部已存节点，含 indirect）
  remote: boolean; // --remote：只搜 hub；与 --local 互斥
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
 * practi search <query...>：三态检索。
 * - 默认（无旗标）= 混合：先本地后 hub，各吃一份 --limit，scope 只作用于远端半场；
 * - --local 只搜本地；--remote 只搜 hub（GET /api/v1/pop/search，标题命中优先）；
 * - 两个旗标同时给是自相矛盾，直接拒。
 * - 空查询 = 浏览：本地看 direct 根，远端看最近公开。
 */
export async function runSearch(opts: SearchOpts): Promise<number> {
  if (opts.local && opts.remote) {
    console.error('error: --local and --remote are mutually exclusive — with neither, search is already both (local first, then the hub)');
    return 1;
  }
  if (!['public', 'me', 'all'].includes(opts.scope)) {
    console.error("error: invalid scope — expected public | me | all");
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const q = opts.positional.join(' ').trim();

  if (opts.local) return localSearch(opts, dataDir, q);
  if (opts.remote) return remoteSearch(opts, dataDir, q);
  return mixedSearch(opts, dataDir, q);
}

/** 混合：本地半场 + 远端半场。远端失败不掩本地结果（照样渲染），但 exit 1 示警。 */
async function mixedSearch(opts: SearchOpts, dataDir: string, q: string): Promise<number> {
  // 未初始化的 data dir 上本地半场降级为空（远端照常）——开箱即搜是混合默认的承诺
  let local: { hits: ReturnType<typeof collectLocal>['hits']; nodesCount: number };
  try {
    local = collectLocal(dataDir, q);
  } catch {
    local = { hits: [], nodesCount: 0 };
  }
  const shownLocal = local.hits.slice(0, opts.limit);

  let rows: SearchRow[] = [];
  let total = 0;
  let remoteErr: string | null = null;
  try {
    const r = await fetchRemote(dataDir, q, opts.scope, opts.limit);
    rows = r.rows;
    total = r.total;
  } catch (e) {
    remoteErr = (e as Error).message;
  }

  if (opts.json) {
    const payload = {
      query: q,
      local: { results: shownLocal, total: local.hits.length },
      remote: remoteErr ? { error: remoteErr } : { results: rows, total },
    };
    console.log(JSON.stringify(payload, null, 2));
    return remoteErr ? 1 : 0;
  }

  console.log('LOCAL (workspace)');
  if (shownLocal.length === 0) {
    console.log(`  ${q ? `no local matches for "${q}"` : '(no direct pops in this workspace)'}`);
  } else {
    for (const hit of shownLocal) printLocalHit(hit);
  }
  console.log(`  ${shownLocal.length} local hit(s) — inspect with \`practi show <hash>\``);

  console.log('\nREMOTE (scope: ' + opts.scope + ')');
  if (remoteErr) {
    console.error(`  hub search failed: ${remoteErr}`);
  } else if (rows.length === 0) {
    console.log(`  ${q ? `no results for "${q}"` : 'no documents yet'}`);
  } else {
    for (const r of rows) printRemoteRow(r);
    console.log(`  ${rows.length} shown (total ${total}, scope: ${opts.scope}) — fetch one with \`practi pull <hash>\``);
  }
  return remoteErr ? 1 : 0;
}

/** --remote：只搜 hub。有凭据走 authed（scope=me/all 需要身份），否则匿名读公开库。 */
async function remoteSearch(opts: SearchOpts, dataDir: string, q: string): Promise<number> {
  let rows: SearchRow[];
  let total: number;
  try {
    const r = await fetchRemote(dataDir, q, opts.scope, opts.limit);
    rows = r.rows;
    total = r.total;
  } catch (e) {
    console.error(`search failed: ${(e as Error).message}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify({ query: q, results: rows, total }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(q ? `no results for "${q}" (scope: ${opts.scope})` : `no documents yet (scope: ${opts.scope})`);
    return 0;
  }
  for (const r of rows) printRemoteRow(r);
  console.log(`\n${rows.length} shown (total ${total}, scope: ${opts.scope}) — fetch one with \`practi pull <hash>\``);
  return 0;
}

async function fetchRemote(
  dataDir: string,
  q: string,
  scope: string,
  limit: number
): Promise<{ rows: SearchRow[]; total: number }> {
  const state = loadState(dataDir);
  if (!state.remote) throw new Error('no remote configured — run `practi remote set <url>` first');
  if (!['public', 'me', 'all'].includes(scope)) {
    throw new Error('invalid scope — expected public | me | all');
  }
  const params = new URLSearchParams({ q, scope, limit: String(limit) });
  const path = `/api/v1/pop/search?${params.toString()}`;
  const authed = hasCredentials(dataDir);
  const res = authed
    ? await authedFetch(dataDir, state.remote.url, path)
    : await fetch(`${state.remote.url}${path}`);
  const body = (await res.json().catch(() => ({}))) as {
    results?: SearchRow[]; total?: number; error?: string; message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return { rows: body.results ?? [], total: body.total ?? body.results?.length ?? 0 };
}

function hasCredentials(dataDir: string): boolean {
  try {
    requireCredentials(dataDir);
    return true;
  } catch {
    return false;
  }
}

function printRemoteRow(r: SearchRow): void {
  const desc = r.description ? ` — ${r.description}` : '';
  const author = r.authorName ? `  @${r.authorName}` : '';
  console.log(`  ${shortHash(r.root_hash)}  [${r.status}]  ${r.name}${desc}${author}`);
  console.log(`    ${r.root_hash}`);
}

/** --local：只搜本地工作区（原语义原样）。 */
function localSearch(opts: SearchOpts, dataDir: string, q: string): number {
  const { hits, nodesCount } = collectLocal(dataDir, q);
  const shown = hits.slice(0, opts.limit);
  if (opts.json) {
    console.log(JSON.stringify({ query: q, local: true, results: shown, total: hits.length }, null, 2));
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

/** 本地命中计算（--local 与混合共用）：
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
