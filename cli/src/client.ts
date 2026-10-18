import {
  loadCredentials,
  saveCredentials,
  isAccessTokenFresh,
  type Credentials,
} from './credentials.js';
import { refreshAccessToken } from './oauth.js';
import { fetchUrl, type FetchUrlResult } from './net.js';

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
    // total 缺省时旧写法恒真=永远只取第一页；按页满即续页收口
    if (results.length === 0 || (body.total !== undefined && out.length >= body.total)) break;
  }
  return out;
}

/** hub 端点一律要 `sha256:` 全形 root_hash；CLI 面子统一接受裸 64-hex 自动补前缀。
 *  前缀短哈希这里不猜——直传端点的命令（clone/comment）没法可靠解析任意公开文档的
 *  前缀，宁要全哈希也不要猜错。返回 null = 不是全哈希。 */
export function normalizeHashRef(ref: string): string | null {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/** POST /api/v1/pop：把文档（创作 JSON 或展开树均可）交给 hub——服务端委托官方 SDK *  解析、规范化、算 root_hash 并认领（默认 PRIVATE）。new --remote / edit --remote 共用。 */
export async function storeDocumentRemote(
  dataDir: string,
  remote: string,
  doc: unknown
): Promise<{ rootHash: string; status: string; idempotent: boolean }> {
  const res = await authedFetch(dataDir, remote, '/api/v1/pop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  const body = (await res.json().catch(() => ({}))) as {
    root_hash?: string; status?: string; idempotent?: boolean; code?: string; message?: string;
  };
  if (!res.ok) {
    const code = body.code ? `[${body.code}] ` : '';
    throw new Error(`${code}${body.message ?? `HTTP ${res.status}`}`);
  }
  if (!body.root_hash) throw new Error('hub stored the document but the response carries no root_hash');
  return { rootHash: body.root_hash, status: body.status ?? 'PRIVATE', idempotent: body.idempotent === true };
}
