import { defaultDataDir, loadState } from '../state.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';

export interface LogOpts {
  dataDir?: string;
  branch?: string;
  limit?: number;
  json?: boolean;
}

interface LogRow {
  seq: number;
  root_hash: string;
  created_at: string;
  name: string | null;
  status: string;
  missing: boolean;
}

/**
 * practi log [--branch <b>] [--limit N] [--json]：当前绑定实例分支的版本历史
 * （tip 在前，hub 的支历史现算视图同序）。git log 同构——seq 是实例内登记序号，
 * 短哈希是全球坐标。
 */
export async function runLog(opts: LogOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  if (!state.instance) {
    console.error('error: no instance bound — use `practi instance bind <owner>/<name>` first');
    return 1;
  }
  const { owner, name, branch } = state.instance;
  const showBranch = opts.branch ?? branch;
  const res = await authedFetch(
    dataDir,
    state.remote.url,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?branch=${encodeURIComponent(showBranch)}`
  );
  const body = (await res.json()) as unknown as {
    branch?: string;
    revisions?: LogRow[];
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    console.error(`error: ${detail}`);
    return 1;
  }
  const rows = body.revisions ?? [];
  if (opts.json === true) {
    console.log(JSON.stringify({ instance: `${owner}/${name}`, branch: body.branch ?? showBranch, revisions: rows }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no revisions on ${owner}/${name}@${body.branch ?? showBranch}`);
    return 0;
  }
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : rows.length;
  for (const r of rows.slice(0, limit)) {
    const date = r.created_at.slice(0, 10);
    const title = r.name ?? '';
    console.log(`v${String(r.seq).padEnd(4)} ${shortHash(r.root_hash)}  ${date}  ${r.status.padEnd(15)} ${title}${r.missing ? ' (document deleted)' : ''}`);
  }
  if (rows.length > limit) console.log(`... ${rows.length - limit} more (use --limit)`);
  return 0;
}
