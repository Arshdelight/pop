import {
  loadCredentials,
  saveCredentials,
  isAccessTokenFresh,
  type Credentials,
} from './credentials.js';
import { refreshAccessToken } from './oauth.js';

/** refresh 被服务端拒绝（token 端点有应答但 HTTP 报错）——凭据已死，需重新 login */
export class RefreshRejectedError extends Error {}
/** token 端点不可达（网络/超时）——凭据生死未知，报"连不上"而非"已过期" */
export class HubUnreachableError extends Error {}

/**
 * 登录态之上的远程请求层：保证请求带有效 Bearer access token。
 * - access token 已过期 → 用 refresh token 换新对（rotation，回写 pop.auth.json）
 * - 401（token 被服务端撤销/aud 不符）→ 刷新一次并重试
 * 刷新失败（refresh 也被撤销/过期）→ 抛错提示重新 `pop login`。
 */

export function requireCredentials(dataDir: string): Credentials {
  const creds = loadCredentials(dataDir);
  if (!creds) {
    throw new Error('not logged in — run `pop login` first');
  }
  return creds;
}

async function refreshAndSave(dataDir: string, remote: string, creds: Credentials): Promise<Credentials> {
  let next: { access_token: string; refresh_token: string; expires_in: number; scope: string };
  try {
    next = await refreshAccessToken(remote, creds.client_id, creds.refresh_token);
  } catch (e) {
    const msg = (e as Error).message;
    if (/^token endpoint failed \(HTTP/.test(msg)) {
      throw new RefreshRejectedError(`session expired or revoked — run \`pop login\` again (${msg})`);
    }
    throw new HubUnreachableError(`cannot reach ${remote} — is the hub running? (${msg})`);
  }
  const updated: Credentials = {
    ...creds,
    access_token: next.access_token,
    refresh_token: next.refresh_token,
    expires_at: Date.now() + next.expires_in * 1000,
    scope: next.scope || creds.scope,
  };
  saveCredentials(dataDir, updated);
  return updated;
}

/** 拿到一个未过期的 access token（必要时自动刷新） */
export async function validAccessToken(dataDir: string, remote: string): Promise<Credentials> {
  const creds = requireCredentials(dataDir);
  if (isAccessTokenFresh(creds)) return creds;
  return refreshAndSave(dataDir, remote, creds);
}

/** 向 remote 发带 Bearer 的请求；401 时刷新一次并重试 */
export async function authedFetch(
  dataDir: string,
  remote: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const creds = await validAccessToken(dataDir, remote);
  const url = /^https?:\/\//i.test(path) ? path : `${remote}${path}`;
  const call = (token: string) =>
    fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });

  let res = await call(creds.access_token as string);
  if (res.status === 401) {
    const refreshed = await refreshAndSave(dataDir, remote, creds);
    res = await call(refreshed.access_token as string);
  }
  return res;
}

/** hub 上「我的」认领列表（DIRECT 根），按 total 分页拉全——push/pull 做认领表 diff 的基准。 */
export async function fetchMine(
  dataDir: string,
  remote: string
): Promise<{ root_hash: string; status: string; name?: string }[]> {
  const out: { root_hash: string; status: string; name?: string }[] = [];
  const limit = 100;
  for (let page = 1; ; page++) {
    const res = await authedFetch(dataDir, remote, `/api/v1/pop/mine?page=${page}&limit=${limit}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`listing own documents failed — ${body.error ?? `HTTP ${res.status}`}`);
    }
    const body = (await res.json()) as {
      results?: { root_hash: string; status: string; name?: string }[];
      total?: number;
    };
    const results = body.results ?? [];
    out.push(...results);
    if (results.length === 0 || out.length >= (body.total ?? out.length)) break;
  }
  return out;
}
