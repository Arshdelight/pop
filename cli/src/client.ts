import {
  loadCredentials,
  saveCredentials,
  isAccessTokenFresh,
  type Credentials,
} from './credentials.js';
import { refreshAccessToken } from './oauth.js';

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
    throw new Error(`session expired or revoked — run \`pop login\` again (${(e as Error).message})`);
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
