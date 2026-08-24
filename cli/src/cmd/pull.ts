import { createFromDoc } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch, fetchMine } from '../client.js';

export interface PullOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop pull [hash]：把 hub 上「我的」认领同步到本地（git pull 语义）。
 * - 分页取 hub 我的认领表（mine），diff 出本地还没认领的，逐个拉文档体并注册为 direct。
 * - 只碰「我的认领」——不涉及公共库，因此不需要归属判断（mine 里的都是自己的）。
 * - 带 hash：只同步 mine 中的那一个（不在 mine 里 → 公共内容请用 `pop clone`）。
 */
export async function runPull(opts: PullOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  const remote = state.remote.url;

  // 分页取 hub 我的认领表（diff 基准）
  let mine: { root_hash: string; status: string; name?: string }[];
  try {
    mine = await fetchMine(dataDir, remote);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  let hashes: string[];
  if (opts.positional[0]) {
    const ref = opts.positional[0];
    const hit = mine.find((r) => r.root_hash === ref || (ref.startsWith('sha256:') && r.root_hash.startsWith(ref)));
    if (!hit) {
      console.error(`error: ${ref} is not in your claims on the remote — for public content use \`pop clone\``);
      return 1;
    }
    hashes = [hit.root_hash];
  } else {
    hashes = mine.map((r) => r.root_hash);
  }

  const local = new Set(loadState(dataDir).direct);
  const toPull = hashes.filter((h) => !local.has(h)); // 本地缺失的认领
  if (toPull.length === 0) {
    console.log(mine.length === 0 ? 'nothing to pull (no own documents on the remote)' : 'up to date — nothing new to pull');
    return 0;
  }

  let failed = 0;
  for (const ref of toPull) {
    failed += await pullOne(dataDir, remote, ref);
  }

  // 提示本地认领而 hub 还没有的（用 push 同步）
  const localOnly = [...local].filter((h) => !mine.some((r) => r.root_hash === h));
  if (localOnly.length > 0) {
    console.log(`note: ${localOnly.length} direct pop(s) exist only locally — run \`pop push\` to sync`);
  }
  return failed ? 1 : 0;
}

async function pullOne(dataDir: string, remote: string, ref: string): Promise<number> {
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(ref)}`);
  const body = (await res.json().catch(() => ({}))) as {
    document?: unknown;
    status?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`pull failed: ${ref} — ${detail}`);
    return 1;
  }
  if (body.document === undefined || body.document === null) {
    console.error(`pull failed: ${ref} — response missing document`);
    return 1;
  }

  const ws = openWorkspace(dataDir);
  const { root } = createFromDoc(ws, body.document);

  const state = loadState(dataDir);
  if (!state.direct.includes(root)) {
    state.direct.push(root);
    saveState(dataDir, state);
  }
  console.log(`pulled:  ${root}  (${body.status ?? 'PUBLISHED'})  [direct]`);
  return 0;
}
