import { exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch, fetchMine } from '../client.js';

export interface PushOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop push [hash]：把本地认领增量推送到 practihub（git push 的对象协商语义）。
 * - 先分页取 hub 上「我的」认领表（mine），diff 出本地认领而 hub 我还没认领的，
 *   只传这些（带 hash 只推该 direct；不带推全部 direct）——不再全量 POST。
 * - 走 POST /api/v1/pop（内容寻址幂等）：hub 没有就存，有则 idempotent 不重复写，
 *   且每次上传都获得 DIRECT 认领。默认存为 PRIVATE；公开仍需 submit 审核。
 */
export async function runPush(opts: PushOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  const ws = openWorkspace(dataDir);
  const targets = opts.positional[0] ? [opts.positional[0]] : state.direct;
  if (targets.length === 0) {
    console.error('error: no direct pops to push (none registered)');
    return 1;
  }

  // 认领表 diff 的基准：hub 上我已认领的 hash 集合
  let mineHashes: Set<string>;
  try {
    const mine = await fetchMine(dataDir, state.remote.url);
    mineHashes = new Set(mine.map((r) => r.root_hash));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  // 解析目标为完整 hash，只保留本地认领而 hub 我还没认领的（增量）
  const toPush: string[] = [];
  let failed = 0;
  for (const ref of targets) {
    let resolved: string;
    try {
      resolved = resolveNodeRef(ws, ref);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      failed++;
      continue;
    }
    if (!mineHashes.has(resolved)) toPush.push(resolved);
  }
  if (toPush.length === 0) {
    console.log('up to date — no new direct pops to push');
    return failed ? 1 : 0;
  }

  for (const ref of toPush) {
    try {
      const node = ws.nodes.get(ref);
      if (!node) throw new Error(`node not found: ${ref}`);
      const doc = exportSubtree(node, ws.nodes);
      const res = await authedFetch(dataDir, state.remote.url, '/api/v1/pop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        console.error(`push failed: ${ref} — ${detail}`);
        failed++;
        continue;
      }
      const name = (doc as { name?: string }).name ?? '';
      const status = String(body.status ?? 'PRIVATE');
      console.log(`pushed:  ${ref}  (${body.idempotent ? 'already existed' : 'stored'}, ${status})  ${name}`);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}
