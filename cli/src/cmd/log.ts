import { resolveRepo } from '../practice.js';
import { shortHash } from '../render.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { fetchDirectInstance } from '../client.js';
import { parseCloneRef } from './clone.js';

export interface LogOpts {
  dir?: string;
  branch?: string;
  limit?: number;
  json?: boolean;
  /** 位置参数：无=本地链；带 `/` 的 `<owner>/<name>[@branch]`=hub 实例；其余报错 */
  ref?: string;
  /** 配置家（远程模式读凭据与 remote）；本地模式不用 */
  dataDir?: string;
}

/**
 * practi log [--branch <b>] [--limit N] [--json]：实例提交历史（本地链，tip 在前）。
 * git log 同构——seq 是链内登记序号，短哈希是全球坐标；未推送到 hub 的提交标注
 * (local, unpushed)。历史编辑（history squash/reword/drop/reset）后的链以此为准，
 * push 时与 hub 对账。
 * 位置参数带 `<owner>/<name>`（含 `@branch`）= 直接读 hub 实例的历史，不经本地文件夹。
 */
export async function runLog(opts: LogOpts): Promise<number> {
  if (opts.ref !== undefined && opts.ref.includes('/')) {
    return logRemote(opts);
  }
  if (opts.ref !== undefined) {
    console.error('usage: practi log   (the local chain, tip first)   |   practi log <owner>/<name>[@branch] [--limit N] [--json]   (a hub practice)');
    return 1;
  }
  const repo = resolveRepo({ dir: opts.dir, verb: 'log' });
  if (repo === null) return 1;
  const chain = repo.chain;
  const branch = opts.branch ?? chain.current;
  const head = chain.branches[branch] ?? null;

  // 该支的提交：从支头沿 parent 回溯（多支时只显示所在链段）
  const byRoot = new Map(chain.commits.map((c) => [c.root, c]));
  const rows = [];
  const seen = new Set<string>();
  let cur: string | null = head;
  while (cur !== null && !seen.has(cur)) {
    const c = byRoot.get(cur);
    if (!c) break;
    seen.add(cur);
    rows.push(c);
    cur = c.parent;
  }

  if (opts.json === true) {
    console.log(JSON.stringify({
      practice: chain.owner ? `${chain.owner}/${chain.name}` : chain.name,
      branch,
      revisions: rows.map((c) => ({ seq: c.seq, root_hash: c.root, parent_hash: c.parent, message: c.message, pushed: c.pushedAt !== undefined })),
    }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no revisions on ${chain.name}@${branch}`);
    return 0;
  }
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : rows.length;
  for (const c of rows.slice(0, limit)) {
    const unpushed = c.pushedAt === undefined ? '  (local, unpushed)' : '';
    console.log(`v${String(c.seq).padEnd(4)} ${shortHash(c.root)}  ${c.message}${unpushed}`);
  }
  if (rows.length > limit) console.log(`... ${rows.length - limit} more (use --limit)`);
  return 0;
}

/** practi log <owner>/<name>[@branch]：hub 上的版本历史（新的在先）。行格式与本地
 *  log 同款，行尾加日期；--json 出 hub 的修订结构（带 created_at/status）。 */
async function logRemote(opts: LogOpts): Promise<number> {
  const usage = 'usage: practi log <owner>/<name>[@branch] [--limit N] [--json]';
  const parsed = parseCloneRef(opts.ref as string);
  if (!parsed || parsed.owner === undefined) {
    console.error('error: a hub practice needs its owner — `practi log <owner>/<name>[@branch]`');
    console.error(usage);
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const remote = remoteUrl(dataDir);
  const view = await fetchDirectInstance(dataDir, remote, parsed.owner, parsed.name, parsed.branch);
  const address = `${parsed.owner}/${view.name}`;
  const rows = view.revisions;

  if (opts.json === true) {
    console.log(JSON.stringify({
      practice: address,
      branch: view.branch,
      revisions: rows.map((r) => ({
        seq: r.seq,
        root_hash: r.root_hash,
        parent_hash: r.parent_hash,
        message: r.message,
        created_at: r.created_at,
        status: r.status,
      })),
    }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no revisions on ${address}@${view.branch}`);
    return 0;
  }
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : rows.length;
  for (const r of rows.slice(0, limit)) {
    const day = /^\d{4}-\d{2}-\d{2}/.exec(r.created_at)?.[0] ?? '-';
    console.log(`v${String(r.seq).padEnd(4)} ${shortHash(r.root_hash)}  ${r.message}  ${day}`);
  }
  if (rows.length > limit) console.log(`... ${rows.length - limit} more (use --limit)`);
  return 0;
}
