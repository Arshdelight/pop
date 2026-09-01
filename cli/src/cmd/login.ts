import { defaultDataDir, loadState } from '../state.js';
import { saveCredentials, deleteCredentials, loadCredentials, isAccessTokenFresh, authPath } from '../credentials.js';
import {
  cliResource,
  discoverAs,
  registerClient,
  createLoopbackSession,
  generatePkcePair,
  buildAuthorizeUrl,
  openAuthorizeUrl,
  exchangeCode,
  revokeToken,
  LOGIN_SCOPES,
} from '../oauth.js';
import { authedFetch, validAccessToken, HubUnreachableError } from '../client.js';

export interface LoginOpts {
  dataDir?: string;
  /** 不自动开浏览器，只打印授权 URL（适合无头环境/agent） */
  noOpen?: boolean;
  /** 退出并重登一步到位：先 revoke + 清凭据再走完整登录；未登录时无痕退化为纯 login */
  reauth?: boolean;
}

/**
 * practi login：OAuth 2.1 Authorization Code + PKCE（loopback 回调）登录 practihub。
 * 浏览器授权 → 换 access+refresh token → 凭证存 $dataDir/practi.auth.json（独立于 workspace 状态）。
 * 之后命令自动用 refresh token 续期（rotation），无需再次交互。
 * --reauth：已登录时不必先 logout——一步重换凭据（revoke 是 best-effort，不阻塞）。
 */
export async function runLogin(opts: LoginOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const remote = state.remote.url;
  const resource = cliResource(remote);
  const existing = loadCredentials(dataDir);
  if (opts.reauth === true && existing) {
    await revokeToken(remote, existing.client_id, existing.refresh_token, 'refresh_token');
    deleteCredentials(dataDir);
    console.log('logged out');
  } else if (existing) {
    if (existing.resource && existing.resource !== resource) {
      // 凭据由另一个 hub 签发，对当前 remote 无用——清掉直接走新登录
      console.error(`note: stored credentials were issued for ${existing.resource}, not ${resource} — clearing them`);
      deleteCredentials(dataDir);
    } else if (isAccessTokenFresh(existing)) {
      console.error('error: already logged in — use `practi login --reauth` (or logout first)');
      return 1;
    } else {
      // access 已过期：探一次 refresh。被拒=凭据已死，自动清除后继续；连不上=生死未知，保留并退出
      try {
        await validAccessToken(dataDir, remote);
        console.error('error: already logged in — use `practi login --reauth` (or logout first)');
        return 1;
      } catch (e) {
        if (e instanceof HubUnreachableError) {
          console.error(`error: already logged in, but the session cannot be verified — ${e.message}`);
          console.error('        use `practi login --reauth` to force a fresh session');
          return 1;
        }
        console.error(`note: stored credentials are dead — clearing them (${(e as Error).message})`);
        deleteCredentials(dataDir);
      }
    }
  }
  console.log(`logging in to ${remote}`);
  console.log(`resource: ${resource}`);
  console.log(`scopes:   ${LOGIN_SCOPES}`);

  const meta = await discoverAs(remote);
  const session = createLoopbackSession();
  try {
    const { client_id: clientId } = await registerClient(remote, session.redirectUri);
    const pkce = generatePkcePair();
    const url = buildAuthorizeUrl({
      authorizationEndpoint: meta.authorization_endpoint,
      clientId,
      redirectUri: session.redirectUri,
      state: session.state,
      codeChallenge: pkce.challenge,
      resource,
    });
    openAuthorizeUrl(url, opts.noOpen !== true);

    const code = await session.waitForCode();
    const tokens = await exchangeCode(remote, {
      clientId,
      redirectUri: session.redirectUri,
      code,
      verifier: pkce.verifier,
    });

    saveCredentials(dataDir, {
      schema: 1,
      client_id: clientId,
      resource,
      scope: tokens.scope || LOGIN_SCOPES,
      client_name: 'practi cli',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });
    console.log(`logged in to ${remote} — credentials stored in ${authPath(dataDir)}`);
    return 0;
  } finally {
    session.close();
  }
}

/** practi logout：服务端 revoke（best-effort）+ 删除本地凭证 */
export async function runLogout(opts: { dataDir?: string }): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const creds = loadCredentials(dataDir);
  if (creds && state.remote) {
    await revokeToken(state.remote.url, creds.client_id, creds.refresh_token, 'refresh_token');
  }
  deleteCredentials(dataDir);
  console.log('logged out');
  return 0;
}

export interface MeOpts {
  dataDir?: string;
}

/** practi me：校验登录态，显示当前用户/角色/scope */
export async function runMe(opts: MeOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const res = await authedFetch(dataDir, state.remote.url, '/api/auth/me');
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`error: not authenticated — ${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`}`);
    return 1;
  }
  console.log(`username:     ${body.username ?? '(unknown)'}`);
  console.log(`profile:      ${body.profileUsername ?? '(none)'}`);
  if (body.role) console.log(`role:         ${body.role}`);
  const creds = loadCredentials(dataDir);
  if (creds?.scope) console.log(`scopes:       ${creds.scope}`);
  console.log(`remote:       ${state.remote.url}`);
  return 0;
}
