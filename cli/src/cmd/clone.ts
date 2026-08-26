import { createFromDoc, parseDocument } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';

export interface CloneOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop clone <hash>：从 hub 取一个文档并认领它（git clone / fork 语义）。
 * - 只用于公共（PUBLISHED）或你本就可读的内容；POP 认领制「能拿到即可认领」。
 * - 本地：落 workspace + 注册为 direct；远端：POST /api/v1/pop（内容寻址幂等）→
 *   你也获得 hub 认领——本地/hub 双向一致，之后 `pop pull` 能拉回。
 * - 已在你的认领里 → 幂等返回。
 */
export async function runClone(opts: CloneOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: pop clone <hash>');
    return 1;
  }
  const remote = state.remote.url;

  // 取文档体（公开可读；私有且非本人会被 hub 拒）
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(ref)}`);
  const body = (await res.json().catch(() => ({}))) as {
    root_hash?: string;
    document?: unknown;
    status?: string;
    ownership?: { mine: boolean; kind: string | null };
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`clone failed: ${ref} — ${detail}`);
    return 1;
  }
  if (body.document === undefined || body.document === null) {
    console.error(`clone failed: ${ref} — response missing document`);
    return 1;
  }

  // 入库前验算（内容寻址的客户端责任）：本地算出的根哈希必须等于请求地址（也是服务器
  // 声称的 root_hash）——注册与推送一律用本地算的值，不采信服务器声称的哈希
  let computedRoot: string;
  try {
    computedRoot = parseDocument(body.document).rootHash;
  } catch (e) {
    console.error(`clone failed: ${ref} — invalid document: ${(e as Error).message}`);
    return 1;
  }
  if (computedRoot !== ref || (body.root_hash !== undefined && body.root_hash !== computedRoot)) {
    console.error(`clone failed: ${ref} — hash mismatch: content hashes to ${computedRoot}`);
    return 1;
  }

  // 落本地 workspace + 注册 direct
  const ws = openWorkspace(dataDir);
  createFromDoc(ws, body.document);
  const rootHash = computedRoot;
  const alreadyMine = body.ownership?.mine === true;

  const localState = loadState(dataDir);
  if (!localState.direct.includes(rootHash)) {
    localState.direct.push(rootHash);
    saveState(dataDir, localState);
  }

  // 同步到 hub 认领（双向一致；幂等）
  const pushRes = await authedFetch(dataDir, remote, '/api/v1/pop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body.document),
  });
  const pushBody = (await pushRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!pushRes.ok) {
    const detail =
      typeof pushBody.message === 'string' ? pushBody.message : typeof pushBody.error === 'string' ? pushBody.error : `HTTP ${pushRes.status}`;
    console.error(`clone failed: ${rootHash} — could not claim on remote: ${detail}`);
    return 1;
  }

  console.log(`cloned:  ${rootHash}  (${body.status ?? 'PUBLISHED'})  [direct]${alreadyMine ? '  (already yours on the remote)' : '  (claimed on remote)'}`);
  return 0;
}
