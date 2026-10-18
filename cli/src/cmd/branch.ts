import { defaultDataDir, loadState } from '../state.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';

export interface BranchOpts {
  dataDir?: string;
  positional: string[];
  from?: string;
  deleteBranch?: string;
}

/**
 * practi branch — 实例分支管理（git branch 同构）：
 *   branch              列全部分支（* = 默认支）
 *   branch <name>       从当前支头（或 --from <hash>，须是实例已登记版本）建新支
 *   branch -d <name>    删分支（纯指针；默认支不可删）
 * 需已 `practi instance bind`。
 */
export async function runBranch(opts: BranchOpts): Promise<number> {
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
  const base = `/api/v1/instances/${encodeURIComponent(state.instance.owner)}/${encodeURIComponent(state.instance.name)}`;

  // 删支：branch -d <name>
  if (opts.deleteBranch) {
    const res = await authedFetch(dataDir, state.remote.url, `${base}/branches/${encodeURIComponent(opts.deleteBranch)}`, {
      method: 'DELETE',
    });
    const body = await res.json();
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
      return 1;
    }
    if (state.instance.branch === opts.deleteBranch) {
      console.log(`note: deleted the current branch — \`practi switch main\` to go back`);
    }
    console.log(`deleted branch: ${opts.deleteBranch} (revisions and documents untouched)`);
    return 0;
  }

  // 建支：branch <name> [--from <hash>]
  const name = opts.positional[0];
  if (name) {
    const res = await authedFetch(dataDir, state.remote.url, `${base}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(opts.from !== undefined && opts.from !== '' ? { from_hash: opts.from } : {}) }),
    });
    const body = await res.json();
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
      return 1;
    }
    console.log(`created branch: ${name} (from ${(body.head_hash ? shortHash(String(body.head_hash)) : 'empty root')})`);
    console.log(`next: \`practi switch ${name}\` then \`practi push <hash>\``);
    return 0;
  }

  // 列表：branch
  const res = await authedFetch(dataDir, state.remote.url, base);
  const body = (await res.json()) as unknown as {
    branches?: { name: string; head_hash: string | null; is_default: boolean }[];
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    console.error(`error: ${detail}`);
    return 1;
  }
  for (const b of body.branches ?? []) {
    console.log(`${b.is_default ? '*' : ' '} ${b.name}${b.head_hash ? `  ${shortHash(b.head_hash)}` : '  (empty)'}`);
  }
  return 0;
}
