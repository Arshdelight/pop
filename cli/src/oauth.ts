import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { openBrowser } from './web.js';

/**
 * OAuth 2.1 client（pop cli ↔ practihub 的 Authorization Server）：
 * 发现 AS metadata → DCR 注册 loopback client → PKCE S256 → 浏览器授权 →
 * loopback 回调收 code → token 端点换 access/refresh。全部走标准端点。
 *
 * 登录流程分步组合（login.ts）：
 *   session = createLoopbackSession()          // 绑定端口，得到 redirectUri + state
 *   { client_id } = registerClient(remote, session.redirectUri)
 *   authorizeUrl = buildAuthorizeUrl(...)      // 含 PKCE challenge + resource + state
 *   code = await session.waitForCode()         // 浏览器授权回调
 *   tokens = await exchangeCode(...)           // code + verifier → access/refresh
 */

export const LOGIN_SCOPES = 'pop:read pop:create pop:publish';
const CALLBACK_PATH = '/callback';
const TIMEOUT_MS = 5 * 60 * 1000; // 授权页等待上限

export interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** CLI 的 resource（RFC 8707 audience）= remote origin + /cli */
export function cliResource(remote: string): string {
  return `${new URL(remote).origin}/cli`;
}

/** 从 AS metadata 或约定路径发现端点；缺失时按 practihub 约定回退 */
export async function discoverAs(remote: string): Promise<AsMetadata> {
  const origin = new URL(remote).origin;
  const defaults: AsMetadata = {
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/auth/oauth/token`,
    registration_endpoint: `${origin}/api/auth/oauth/register`,
    revocation_endpoint: `${origin}/api/auth/oauth/revoke`,
  };
  try {
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return defaults;
    const meta = (await res.json()) as Partial<AsMetadata>;
    return {
      authorization_endpoint: meta.authorization_endpoint ?? defaults.authorization_endpoint,
      token_endpoint: meta.token_endpoint ?? defaults.token_endpoint,
      registration_endpoint: meta.registration_endpoint ?? defaults.registration_endpoint,
      revocation_endpoint: meta.revocation_endpoint ?? defaults.revocation_endpoint,
    };
  } catch {
    return defaults;
  }
}

/** DCR（RFC 7591）：注册一个 loopback 回调的 public client */
export async function registerClient(
  remote: string,
  redirectUri: string
): Promise<{ client_id: string }> {
  const meta = await discoverAs(remote);
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'pop cli',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: LOGIN_SCOPES,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`client registration failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { client_id: string };
}

/** PKCE S256：verifier + challenge */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface LoopbackSession {
  /** 带实际端口号的回调地址（DCR 注册与 authorize 都用它） */
  redirectUri: string;
  /** CSRF state（要放进 authorize URL 并在回调校验） */
  state: string;
  /** 等待浏览器回调，返回 authorization code（拒绝/超时则 reject） */
  waitForCode(): Promise<string>;
  /** 收尾关闭 server（finally 里调用） */
  close(): void;
}

/**
 * 起 loopback server（RFC 8252）并绑定端口。
 * 必须在 DCR 注册前创建（redirectUri 含端口，注册与授权必须一致）。
 */
export function createLoopbackSession(): LoopbackSession {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const state = randomBytes(16).toString('hex');

  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end(simplePage('Authorization failed', `The authorization server returned an error: ${escapeHtml(error)}`));
      finish(new Error(`authorization denied: ${error}`));
      return;
    }
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    if (!code || stateParam !== state) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end(simplePage('Authorization failed', 'Missing or mismatched code/state.'));
      finish(new Error('authorization callback missing code or state mismatch'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(simplePage('Logged in', 'You can close this window and return to the terminal.'));
    finish(null, code);
  });
  server.on('error', (err) => finish(err));
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    timer = setTimeout(() => finish(new Error('authorization timed out — no browser callback received')), TIMEOUT_MS);
  });

  function finish(err: Error | null, code?: string) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    server.close(() => {});
    if (err) rejectCode?.(err);
    else resolveCode?.(code ?? '');
  }

  return {
    get redirectUri(): string {
      return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    },
    state,
    waitForCode: () => codePromise,
    close: () => finish(new Error('login aborted')),
  };
}

/** 组装授权 URL（浏览器打开用） */
export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('scope', LOGIN_SCOPES);
  url.searchParams.set('resource', opts.resource);
  return url.toString();
}

/** 打开浏览器（或打印 URL 供手动打开） */
export function openAuthorizeUrl(url: string, open: boolean): void {
  if (open) openBrowser(url);
  else console.log(`open this URL in your browser:\n  ${url}`);
}

/** authorization_code grant：code + verifier → access/refresh */
export async function exchangeCode(
  remote: string,
  opts: { clientId: string; redirectUri: string; code: string; verifier: string }
): Promise<TokenResponse> {
  const meta = await discoverAs(remote);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    code_verifier: opts.verifier,
  });
  return postToken(meta.token_endpoint, body);
}

/** 用 refresh token 换新的 access/refresh 对（rotation） */
export async function refreshAccessToken(
  remote: string,
  clientId: string,
  refreshToken: string
): Promise<TokenResponse> {
  const meta = await discoverAs(remote);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  return postToken(meta.token_endpoint, body);
}

async function postToken(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error_description?: string; error?: string };
      detail = j.error_description ?? j.error ?? text;
    } catch {
      // 保留原文
    }
    throw new Error(`token endpoint failed (HTTP ${res.status}): ${detail}`);
  }
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token || !data.refresh_token) {
    throw new Error('token endpoint returned an invalid response (missing access_token/refresh_token)');
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? 3600,
    scope: data.scope ?? '',
  };
}

/** 撤销 token（RFC 7009，best-effort：失败不抛错） */
export async function revokeToken(
  remote: string,
  clientId: string,
  token: string,
  tokenTypeHint?: 'access_token' | 'refresh_token'
): Promise<void> {
  try {
    const meta = await discoverAs(remote);
    const body = new URLSearchParams({ token, client_id: clientId });
    if (tokenTypeHint) body.set('token_type_hint', tokenTypeHint);
    await fetch(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort：本地凭证已删，revoke 失败不阻塞 logout
  }
}

function simplePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px/1.6 system-ui,sans-serif;margin:40px auto;max-width:480px;text-align:center">
<h1>${title}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
