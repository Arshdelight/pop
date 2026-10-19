import {
  loadCredentials,
  saveCredentials,
  isAccessTokenFresh,
  type Credentials,
} from './credentials.js';
import { refreshAccessToken } from './oauth.js';
import { fetchUrl, type FetchUrlResult } from './net.js';
import { createFromDoc, parseDocument } from '@arshdelight/pop-sdk';
import { openWorkspace } from './workspace.js';

/** refresh 被服务端拒绝（token 端点有应答但 HTTP 报错）——凭据已死，需重新 login */
export class RefreshRejectedError extends Error {}
/** token 端点不可达（网络/超时）——凭据生死未知，报"连不上"而非"已过期" */
export class HubUnreachableError extends Error {}

/**
 * authedFetch 的返回面：旧 Response 形状的极简子集（ok/status/json/text），
 * 底座是 net.ts#fetchUrl（AGENTS.md 网络统一入口：自动走系统代理）。body 已在内存，
 * json()/text() 是同一份文本的两种读法。
 */
export interface ApiReply {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
  text(): Promise<string>;
}

function toReply(r: FetchUrlResult): ApiReply {
  const text = r.bytes.toString('utf8');
  return {
    ok: r.ok,
    status: r.status,
    json: async () => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    text: async () => text,
  };
}

/**
 * 登录态之上的远程请求层：保证请求带有效 Bearer access token。
 * - access token 已过期 → 用 refresh token 换新对（rotation，回写 practi.auth.json）
 * - 401（token 被服务端撤销/aud 不符）→ 刷新一次并重试
 * 刷新失败（refresh 也被撤销/过期）→ 抛错提示 `practi login --reauth`。
 */

export function requireCredentials(dataDir: string): Credentials {
  const creds = loadCredentials(dataDir);
  if (!creds) {
    throw new Error('not logged in — run `practi login` first');
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
      throw new RefreshRejectedError(`session expired or revoked — run \`practi login --reauth\` again (${msg})`);
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

export interface AuthedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 向 remote 发带 Bearer 的请求；401 时刷新一次并重试 */
export async function authedFetch(
  dataDir: string,
  remote: string,
  path: string,
  init?: AuthedRequest
): Promise<ApiReply> {
  const creds = await validAccessToken(dataDir, remote);
  const url = /^https?:\/\//i.test(path) ? path : `${remote}${path}`;
  const call = (token: string) =>
    fetchUrl(url, {
      method: init?.method,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
      body: init?.body,
    });

  let res = await call(creds.access_token as string);
  if (res.status === 401) {
    try {
      const refreshed = await refreshAndSave(dataDir, remote, creds);
      res = await call(refreshed.access_token as string);
    } catch (e) {
      // 轮换竞态的优雅收口（无锁）：两个并发进程同时 401 时，输家拿旧 refresh_token 去换会被拒。
      // 被拒 ≠ 凭据死了——重读一次盘，refresh_token 变了说明赢家刚轮换成功，改用新凭据重试。
      if (e instanceof RefreshRejectedError) {
        const reloaded = loadCredentials(dataDir);
        if (reloaded && reloaded.refresh_token !== creds.refresh_token) {
          const again = await validAccessToken(dataDir, remote);
          res = await call(again.access_token as string);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  }
  return toReply(res);
}

/** hub 端点一律要 `sha256:` 全形 root_hash；CLI 面子统一接受裸 64-hex 自动补前缀。
 *  前缀短哈希这里不猜——直传端点的命令没法可靠解析任意公开文档的前缀，
 *  宁要全哈希也不要猜错。返回 null = 不是全哈希。 */
export function normalizeHashRef(ref: string): string | null {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/** GET /api/v1/instances/{owner}/{name}/revisions/{hash} + 入库前验算（内容寻址的客户端责任，
 *  hub 读路径不代验）：纯导入（不落库）算出的根哈希必须等于请求地址——不符即拒绝，防止
 *  「另一身份的文档被悄悄注册进本地库」。pull/fetch 共用。
 *  访问带仓库上下文（GitHub blobs 同构，2026-10-19 拍板；全局 /api/v1/pop/:ref 已退役）：
 *  公开实例任何人可拉，私有实例仅 owner/admin。 */
export async function fetchRemoteDoc(
  dataDir: string,
  remote: string,
  owner: string,
  name: string,
  ref: string
): Promise<{ rootHash: string; status: string }> {
  const res = await authedFetch(
    dataDir,
    remote,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/revisions/${encodeURIComponent(ref)}`
  );
  const body = (await res.json().catch(() => ({}))) as {
    document?: unknown;
    status?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(`${ref} — ${detail}`);
  }
  if (body.document === undefined || body.document === null) {
    throw new Error(`${ref} — response missing document`);
  }
  const parsed = parseDocument(body.document);
  if (parsed.rootHash !== ref) {
    throw new Error(`${ref} — hash mismatch: content hashes to ${parsed.rootHash}`);
  }
  const ws = openWorkspace(dataDir);
  createFromDoc(ws, body.document);
  return { rootHash: parsed.rootHash, status: body.status ?? 'PRIVATE' };
}
