import { DEFAULT_REMOTE_URL, defaultDataDir, describeDataDir, loadState, remoteUrl } from '../state.js';
import { CLI_VERSION, POP_SPEC_VERSION } from '../version.js';
import {
  saveCredentials,
  deleteCredentials,
  loadCredentials,
  isAccessTokenFresh,
  authPath,
  type Credentials,
} from '../credentials.js';
import {
  cliResource,
  clientExists,
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
import {
  loadRegisteredClientId,
  saveRegisteredClientId,
  forgetRegisteredClientId,
} from '../client-registry.js';
import { authedFetch, validAccessToken, HubUnreachableError } from '../client.js';

export interface LoginOpts {
  dataDir?: string;
  /** 不自动开浏览器，只打印授权 URL（适合无头环境/agent） */
  noOpen?: boolean;
  /** 退出并重登一步到位：先 revoke + 清凭据再走完整登录；未登录时无痕退化为纯 login */
  reauth?: boolean;
}

/**
 * 升级衔接：删旧凭据前，把凭据里的 client_id 抢救进登记文件（该 remote 还没有登记时）——
 * 0.29 之前的用户第一次重登不用新登记。只认与本次 resource 一致的凭据，
 * 另一个 hub 签发的 client_id 对当前 remote 没有意义。
 */
function carryOverRegisteredClient(dataDir: string, remote: string, resource: string, creds: Credentials): void {
  if (!creds.client_id) return;
  if (creds.resource && creds.resource !== resource) return;
  if (loadRegisteredClientId(dataDir, remote) !== null) return;
  saveRegisteredClientId(dataDir, remote, creds.client_id);
}

/**
 * practi login：OAuth 2.1 Authorization Code + PKCE（loopback 回调）登录 practihub。
 * 浏览器授权 → 换 access+refresh token → 凭证存 $dataDir/practi.auth.json（独立于 workspace 状态）。
 * 之后命令自动用 refresh token 续期（rotation），无需再次交互。
 * client_id 按 remote 记在 $dataDir/practi.client.json：登记一次就复用，不再每次登录都往 hub
 * 新增一条登记（hub 对回环回调忽略端口比较，RFC 8252——一个登记可以一直用）。
 * 登记在 hub 侧没了（client-info 404）才重新登记——每次登录前先问一次。
 * --reauth：已登录时不必先 logout——一步重换凭据（revoke 是 best-effort，不阻塞）。
 */
export async function runLogin(opts: LoginOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const remote = remoteUrl(dataDir);
  const resource = cliResource(remote);
  const existing = loadCredentials(dataDir);
  if (opts.reauth === true && existing) {
    const revokeTarget = existing.resource && existing.resource !== resource
      ? existing.resource.replace(/\/cli$/, '')
      : remote;
    await revokeToken(revokeTarget, existing.client_id, existing.refresh_token, 'refresh_token');
    carryOverRegisteredClient(dataDir, remote, resource, existing);
    deleteCredentials(dataDir);
    console.log('logged out');
  } else if (existing) {
    if (existing.resource && existing.resource !== resource) {
      // 凭据由另一个 hub 签发，对当前 remote 无用——清掉直接走新登录
      // （client_id 不抢救：那是另一个 hub 的登记）
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
        carryOverRegisteredClient(dataDir, remote, resource, existing);
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
    // client_id 复用：登记文件里有就先问 hub 是否还认——exists/unknown 都复用（unknown 是
    // 网络失败或应答形状不对，不能因此多登记一条），只有 missing（hub 确认没了）才重登记。
    let clientId = loadRegisteredClientId(dataDir, remote);
    if (clientId !== null && (await clientExists(remote, clientId)) === 'missing') {
      forgetRegisteredClientId(dataDir, remote);
      clientId = null;
    }
    if (clientId === null) {
      const { client_id: fresh } = await registerClient(remote, session.redirectUri);
      // 立刻记账，赶在打开浏览器之前：授权随时可能被中途放弃，登记先落盘，下次登录直接复用
      saveRegisteredClientId(dataDir, remote, fresh);
      clientId = fresh;
    }
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

/** practi me：登录态 + 配置面（原 `practi config` 并入，2026-11-27）。未登录也打印
 *  配置家与 remote（标明默认值还是 remote set 设的），并指路 `practi login`。 */
export async function runMe(opts: MeOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const { dir, via } = describeDataDir(opts.dataDir);
  const state = loadState(dataDir);
  const configured = state.remote !== undefined;
  const remote = configured ? state.remote!.url : DEFAULT_REMOTE_URL;
  console.log(`practi:    ${CLI_VERSION}   pop-spec: ${POP_SPEC_VERSION}`);
  console.log(`config home: ${dir}  (via ${via})  — credentials + remote; practice folders live anywhere`);
  console.log(`remote:     ${remote}${configured ? '  (set with `practi remote set`)' : '  (default — change with `practi remote set <url>`)'}`);
  const creds = loadCredentials(dataDir);
  if (!creds) {
    console.error('not logged in — run `practi login` first');
    return 1;
  }
  const res = await authedFetch(dataDir, remote, '/api/auth/me');
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`error: not authenticated — ${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`}`);
    return 1;
  }
  console.log(`username:     ${body.username ?? '(unknown)'}`);
  console.log(`profile:      ${body.profileUsername ?? '(none)'}`);
  if (body.role) console.log(`role:         ${body.role}`);
  if (creds.scope) console.log(`scopes:       ${creds.scope}`);
  return 0;
}
