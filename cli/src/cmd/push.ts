import { exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';

export interface PushOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop push [hash]：把本地 POP 上传到 practihub。
 * - 带 hash：推送该 direct root（或任意已存节点）对应的规范文档。
 * - 不带：推送全部 direct roots。
 * 走 POST /api/v1/pop（内容寻址幂等），默认存为 PRIVATE；公开仍需 submit 审核。
 */
export async function runPush(opts: PushOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  const ws = openWorkspace(dataDir);
  const hashes = opts.positional[0] ? [opts.positional[0]] : state.direct;
  if (hashes.length === 0) {
    console.error('error: no direct pops to push (none registered)');
    return 1;
  }

  let failed = 0;
  for (const ref of hashes) {
    try {
      const resolved = resolveNodeRef(ws, ref);
      const node = ws.nodes.get(resolved);
      if (!node) throw new Error(`node not found: ${resolved}`);
      const doc = exportSubtree(node, ws.nodes);
      const res = await authedFetch(dataDir, state.remote.url, '/api/v1/pop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        console.error(`push failed: ${resolved} — ${detail}`);
        failed++;
        continue;
      }
      const name = (doc as { name?: string }).name ?? '';
      const status = String(body.status ?? 'PRIVATE');
      console.log(`pushed:  ${resolved}  (${body.idempotent ? 'already existed' : 'stored'}, ${status})  ${name}`);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}
