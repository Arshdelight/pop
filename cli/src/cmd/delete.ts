import fs from 'node:fs';
import path from 'node:path';
import { loadCredentials } from '../credentials.js';
import { authedFetch } from '../client.js';
import { defaultDataDir, loadState } from '../state.js';

export interface DeleteOpts {
  dataDir?: string;
  positional: string[];
  yes?: boolean;
  local?: string;
}

function parseTarget(target: string | undefined): { owner: string; name: string } | null {
  if (!target || !/^[^/]+\/[^/]+$/.test(target)) return null;
  const [owner, name] = target.split('/');
  return { owner, name };
}

/** practi delete <owner>/<name> --yes [--local <dir>] — 删 hub 实例（不可逆：实例登记与修订一并消失，
 *  文档字节内容寻址、认领独立所以不动）。--local 同时删本地文件夹——先核对该文件夹确实是同一个实例
 *  （chain.json 的 name 相同；记录了 owner 的还要 owner 相同），不是就拒删。 */
export async function runDelete(opts: DeleteOpts): Promise<number> {
  const dir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const target = parseTarget(opts.positional[0]);
  if (!target) {
    console.error('usage: practi delete <owner>/<name> --yes [--local <dir>]');
    return 1;
  }
  const { owner, name } = target;
  const creds = loadCredentials(dir);
  if (!creds) {
    console.error('error: not logged in — run `practi login` first');
    return 1;
  }
  if (!(creds.scope ?? '').split(/\s+/).includes('practice:delete')) {
    console.error("error: this login has no `practice:delete` scope — run `practi login --reauth` and tick the delete scope");
    return 1;
  }
  if (!opts.yes) {
    console.log(`this permanently deletes the hub instance ${owner}/${name} and its revisions.`);
    console.log('re-run with --yes to confirm.');
    return 1;
  }

  let localPath: string | null = null;
  if (opts.local) {
    localPath = path.resolve(opts.local);
    const chainFile = path.join(localPath, '.practi', 'chain.json');
    const chain = fs.existsSync(chainFile)
      ? (JSON.parse(fs.readFileSync(chainFile, 'utf8')) as { name?: unknown; owner?: unknown })
      : null;
    // 本地新建未推送的文件夹 owner 为 null；记录了 owner 的必须对得上
    if (!chain || chain.name !== name || (chain.owner != null && chain.owner !== owner)) {
      console.error(`error: ${localPath} is not a practice folder named "${name}" — refusing --local`);
      return 1;
    }
  }

  const res = await authedFetch(
    dir,
    state.remote.url,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  );
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    const detail =
      typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '';
    console.error(`error: hub returned HTTP ${res.status}${body.code ? ` (${String(body.code)})` : ''}${detail ? ` — ${detail}` : ''}`);
    return 1;
  }
  console.log(`deleted: ${owner}/${name} — the hub instance and its revisions are gone (not recoverable)`);
  if (localPath) {
    fs.rmSync(localPath, { recursive: true, force: true });
    console.log(`removed local folder: ${localPath}`);
  }
  return 0;
}
