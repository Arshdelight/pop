import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { execFileSync } from 'node:child_process';

/**
 * 带代理的 HTTP 取件 —— 一个真实的坑，不是一个防御性抽象。
 *
 * Node 的全局 `fetch`（undici）**不读 Windows 的 WinINET 代理设置**：机器上开着
 * Clash/V2Ray（注册表 ProxyServer=127.0.0.1:7897）时，PowerShell 与 Python 走代理
 * 一切正常，而 `practi blob add <https url>` 直接 `error: fetch failed`——实测复现。
 * Node 24 有 `--use-env-proxy` 启动开关，但那是**进程启动时**的开关，发布出去的 CLI
 * 不能要求用户加它；即便加了，`HTTPS_PROXY` 环境变量也不会自己出现在用户的机器上。
 *
 * 所以这里自己实现：解析代理（环境变量优先 → Windows 注册表回落），
 * https 走 CONNECT 隧道，http 走绝对 URI 直送代理。没有代理时原样交给全局 fetch
 * （那条路径行为完全不变，重定向等仍由 undici 处理）。
 */

const UA = 'practi (+https://github.com/Arshdelight/pop)';

export interface ProxySettings {
  /** `host:port` 或 `http=h:p;https=h:p` 形态 */
  server: string;
  /** 分号分隔的绕过列表（WinINET 的 ProxyOverride） */
  override?: string;
}

export interface ResolveProxyOptions {
  env?: NodeJS.ProcessEnv;
  /** 显式传入系统代理（测试用）；undefined = 读注册表，null = 当作没有 */
  systemProxy?: ProxySettings | null;
}

function envAny(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n] ?? env[n.toLowerCase()] ?? env[n.toUpperCase()];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** `host:port` 缺少 scheme 时补 http://（WinINET 存的就是裸 host:port） */
function asProxyUrl(raw: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.hostname === '' ? null : u;
  } catch {
    return null;
  }
}

/** `http=h:p;https=h:p` → 按 scheme 取；不分区时整串就是代理 */
export function pickProxyServer(server: string, scheme: 'http' | 'https'): string | null {
  if (!server.includes('=')) return server.trim() === '' ? null : server.trim();
  const parts = new Map<string, string>();
  for (const seg of server.split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts.set(seg.slice(0, i).trim().toLowerCase(), seg.slice(i + 1).trim());
  }
  return parts.get(scheme) ?? parts.get('http') ?? parts.get('https') ?? null;
}

/** NO_PROXY / ProxyOverride：`*` 全放行，`.foo.com` 与 `foo.com` 按后缀匹配，`<local>` 放行无点主机名 */
export function isBypassed(hostname: string, list: string | undefined): boolean {
  if (list === undefined || list.trim() === '') return false;
  const h = hostname.toLowerCase();
  for (const raw of list.split(',')) {
    const item = raw.trim().toLowerCase();
    if (item === '') continue;
    if (item === '*') return true;
    if (item === '<local>') {
      if (!h.includes('.')) return true;
      continue;
    }
    const bare = item.replace(/^\./, '').replace(/:\d+$/, '');
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

let winCache: ProxySettings | null | undefined;

/** Windows 系统代理（只读注册表；`reg` 不可用时静默当作没有，绝不因此报错） */
function windowsSystemProxy(): ProxySettings | null {
  if (winCache !== undefined) return winCache;
  winCache = null;
  if (process.platform !== 'win32') return winCache;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query = (name: string): string | null => {
    try {
      return execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  const enabled = query('ProxyEnable');
  if (enabled === null || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return winCache;
  const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(query('ProxyServer') ?? '')?.[1]?.trim();
  if (server === undefined || server === '') return winCache;
  const override = /ProxyOverride\s+REG_SZ\s+(.+)/i.exec(query('ProxyOverride') ?? '')?.[1]?.trim();
  winCache = { server, ...(override !== undefined && override !== '' ? { override } : {}) };
  return winCache;
}

/** 目标 URL 该走哪个代理；没有则 null（null = 直连，交给全局 fetch） */
export function resolveProxyFor(target: URL, opts: ResolveProxyOptions = {}): URL | null {
  const env = opts.env ?? process.env;
  const noProxy = envAny(env, 'NO_PROXY', 'no_proxy');
  if (isBypassed(target.hostname, noProxy)) return null;

  const scheme = target.protocol === 'https:' ? 'https' : 'http';
  const fromEnv = scheme === 'https'
    ? envAny(env, 'HTTPS_PROXY', 'ALL_PROXY')
    : envAny(env, 'HTTP_PROXY', 'ALL_PROXY');
  if (fromEnv !== undefined) return asProxyUrl(fromEnv);

  const sys = opts.systemProxy === undefined ? windowsSystemProxy() : opts.systemProxy;
  if (sys === null) return null;
  if (isBypassed(target.hostname, sys.override)) return null;
  const picked = pickProxyServer(sys.server, scheme);
  return picked === null ? null : asProxyUrl(picked);
}

/* ───────────────────────── 取件 ───────────────────────── */

export interface FetchUrlResult {
  status: number;
  ok: boolean;
  contentType?: string;
  bytes: Buffer;
  /** 跟随重定向后的最终 URL */
  finalUrl: string;
}

export interface FetchUrlOptions {
  maxBytes?: number;
  maxRedirects?: number;
  proxy?: ResolveProxyOptions;
}

/**
 * https 隧道：CONNECT 拿到的只是**裸 TCP**，必须自己在其上做 TLS 握手再交给
 * https.request。直接把裸 socket 当 createConnection 的返回值用，等于对着 TLS 服务端
 * 说明文 HTTP —— 报错是 `Parse Error: Expected HTTP/, RTSP/ or ICE/`（实测踩过）。
 */
class TunnelAgent extends https.Agent {
  private readonly tunnel: net.Socket;
  private readonly servername: string;
  constructor(tunnel: net.Socket, servername: string) {
    super({ keepAlive: false, maxSockets: 1 });
    this.tunnel = tunnel;
    this.servername = servername;
  }
  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex {
    const secure = tls.connect({ socket: this.tunnel, servername: this.servername });
    callback?.(null, secure);
    return secure;
  }
}

/** CONNECT 隧道（导出供测试直接驱动握手与拒绝路径） */
export function connectTunnel(proxy: URL, target: URL): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const port = target.port !== '' ? target.port : '443';
    const headers: Record<string, string> = { host: `${target.hostname}:${port}` };
    if (proxy.username !== '' || proxy.password !== '') {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port !== '' ? Number(proxy.port) : 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${target.hostname}:${port} → HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', (e) => reject(new Error(`proxy ${proxy.host} unreachable: ${e.message}`)));
    req.end();
  });
}

async function readBody(res: http.IncomingMessage, maxBytes: number, url: string): Promise<Buffer> {
  const declared = Number(res.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new Error(`file too large: ${declared} bytes (limit ${maxBytes})`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      res.destroy();
      throw new Error(`file too large: over ${maxBytes} bytes (limit) from ${url}`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 单跳请求（已确定走代理） */
async function proxiedOnce(target: URL, proxy: URL, maxBytes: number): Promise<{ status: number; location?: string; contentType?: string; bytes: Buffer }> {
  const headers: Record<string, string> = { host: target.host, 'user-agent': UA, accept: '*/*' };
  let res: http.IncomingMessage;

  if (target.protocol === 'https:') {
    const socket = await connectTunnel(proxy, target);
    res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = https.request({
        host: target.hostname,
        port: target.port !== '' ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        agent: new TunnelAgent(socket, target.hostname),
      }, resolve);
      req.on('error', reject);
      req.end();
    });
  } else {
    res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port !== '' ? Number(proxy.port) : 80,
        path: target.href, // http 走代理用绝对 URI
        method: 'GET',
        headers,
      }, resolve);
      req.on('error', (e) => reject(new Error(`proxy ${proxy.host} unreachable: ${e.message}`)));
      req.end();
    });
  }

  const status = res.statusCode ?? 0;
  const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
  const contentType = typeof res.headers['content-type'] === 'string'
    ? res.headers['content-type'].split(';')[0].trim().toLowerCase()
    : undefined;
  if (status >= 300 && status < 400) {
    res.destroy();
    return { status, ...(location !== undefined ? { location } : {}), bytes: Buffer.alloc(0) };
  }
  const bytes = await readBody(res, maxBytes, target.href);
  return { status, ...(contentType !== undefined ? { contentType } : {}), bytes };
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 取一个 http(s) URL 的字节。有代理就自己走（CONNECT / 绝对 URI + 手动跟随重定向），
 * 没有代理就用全局 fetch（行为与改动前完全一致）。
 */
export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<FetchUrlResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;
  const target = new URL(url);
  const proxy = resolveProxyFor(target, opts.proxy);

  if (proxy === null) {
    const res = await fetch(url, { redirect: 'follow' });
    const contentType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`file too large: ${declared} bytes (limit ${maxBytes})`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`file too large: ${bytes.length} bytes (limit ${maxBytes})`);
    return {
      status: res.status,
      ok: res.ok,
      ...(contentType !== undefined && contentType !== '' ? { contentType } : {}),
      bytes,
      finalUrl: res.url === '' ? url : res.url,
    };
  }

  let current = target;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const r = await proxiedOnce(current, proxy, maxBytes);
    if (r.status >= 300 && r.status < 400 && r.location !== undefined) {
      current = new URL(r.location, current);
      continue;
    }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
      bytes: r.bytes,
      finalUrl: current.href,
    };
  }
  throw new Error(`too many redirects (> ${maxRedirects}) for ${url}`);
}
