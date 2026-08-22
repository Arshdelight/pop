import { createFromDoc } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';

export interface PullOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop pull [hash]：从 practihub 拉取 POP 到本地 workspace。
 * - 带 hash：GET /api/v1/pop/:ref 拉单个（公开文档匿名可读，私有需登录且为 owner）。
 * - 不带：拉取 /api/v1/pop/mine 里我自己的全部文档。
 * 归属：pull 全部（mine）以及私有状态文档一定是自己的 → 注册为 direct；
 * 公开文档单拉 → 只落库为间接节点（不占 direct，避免把别人的文档当成自己的上传）。
 */
export async function runPull(opts: PullOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }

  if (opts.positional[0]) {
    // 单拉：私有文档一定是自己的（直接 [direct]）；公开文档用 /me 对照 owners 判断归属
    const myUsername = await currentProfileUsername(dataDir, state.remote.url);
    return pullOne(dataDir, state.remote.url, opts.positional[0], { myUsername });
  }

  // 拉全部 mine：先列清单，再逐个取文档体（mine 列表不含 canonical_doc）
  const res = await authedFetch(dataDir, state.remote.url, '/api/v1/pop/mine?limit=100');
  const body = (await res.json().catch(() => ({}))) as { results?: { root_hash: string; status: string; name?: string }[] };
  if (!res.ok) {
    console.error(`error: listing own documents failed — ${body && (body as Record<string, unknown>).error ? (body as Record<string, unknown>).error : `HTTP ${res.status}`}`);
    return 1;
  }
  const results = body.results ?? [];
  if (results.length === 0) {
    console.log('nothing to pull (no own documents on the remote)');
    return 0;
  }
  let failed = 0;
  for (const r of results) {
    failed += await pullOne(dataDir, state.remote.url, r.root_hash, { forceDirect: true });
  }
  return failed ? 1 : 0;
}

/** 取当前登录用户的 profile username（/api/auth/me），失败返回 null（不影响拉取） */
async function currentProfileUsername(dataDir: string, remote: string): Promise<string | null> {
  try {
    const res = await authedFetch(dataDir, remote, '/api/auth/me');
    if (!res.ok) return null;
    const body = (await res.json()) as { profileUsername?: string | null };
    return body.profileUsername ?? null;
  } catch {
    return null;
  }
}

async function pullOne(
  dataDir: string,
  remote: string,
  ref: string,
  opts?: { forceDirect?: boolean; myUsername?: string | null }
): Promise<number> {
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(ref)}`);
  const body = (await res.json().catch(() => ({}))) as {
    root_hash?: string;
    document?: unknown;
    status?: string;
    owners?: { id: string; username: string | null; kind: string }[];
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

  // 归属：mine 列表拉取或私有状态 → 一定是自己的；公开文档对照 owners 的 DIRECT 认领者
  const direct =
    opts?.forceDirect === true ||
    (body.status !== undefined && body.status !== 'PUBLISHED') ||
    (opts?.myUsername !== undefined &&
      opts.myUsername !== null &&
      (body.owners ?? []).some((o) => o.kind === 'DIRECT' && o.username === opts.myUsername));
  if (direct) {
    const state = loadState(dataDir);
    if (!state.direct.includes(root)) {
      state.direct.push(root);
      saveState(dataDir, state);
    }
  }
  console.log(`pulled:  ${root}  (${body.status ?? 'PUBLISHED'})${direct ? '  [direct]' : '  [indirect]'}`);
  return 0;
}
