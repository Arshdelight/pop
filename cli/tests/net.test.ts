import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectTunnel, fetchUrl, isBypassed, pickProxyServer, resolveProxyFor } from '../src/net.js';

/**
 * 代理取件。这组用例存在的理由是一个**实测过的真实故障**：
 * Node 的 fetch 不读 Windows 注册表里的系统代理，于是开着 Clash 的机器上
 * `practi blob add <https url>` 直接 "fetch failed"。所以这里既测纯解析逻辑，
 * 也用真 socket 起一个本地代理端到端跑一遍。
 */

const servers: (http.Server | net.Server)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

/* ── 纯解析 ── */

describe('resolveProxyFor', () => {
  const sys = { server: '127.0.0.1:7897' };

  it('uses HTTPS_PROXY for https and HTTP_PROXY for http', () => {
    const env = { HTTPS_PROXY: 'http://p-https:1', HTTP_PROXY: 'http://p-http:2' };
    expect(resolveProxyFor(new URL('https://x.test/a'), { env, systemProxy: null })?.port).toBe('1');
    expect(resolveProxyFor(new URL('http://x.test/a'), { env, systemProxy: null })?.port).toBe('2');
  });

  it('accepts lower-case env names and ALL_PROXY as a fallback', () => {
    expect(resolveProxyFor(new URL('https://x.test/'), { env: { https_proxy: 'http://low:3' }, systemProxy: null })?.port).toBe('3');
    expect(resolveProxyFor(new URL('https://x.test/'), { env: { ALL_PROXY: 'http://all:4' }, systemProxy: null })?.port).toBe('4');
  });

  it('honours NO_PROXY suffixes, wildcard and <local>', () => {
    const env = { HTTPS_PROXY: 'http://p:1' };
    expect(resolveProxyFor(new URL('https://api.internal/'), { env: { ...env, NO_PROXY: 'internal' }, systemProxy: null })).toBeNull();
    expect(resolveProxyFor(new URL('https://a.b.internal/'), { env: { ...env, NO_PROXY: '.b.internal' }, systemProxy: null })).toBeNull();
    expect(resolveProxyFor(new URL('https://any.test/'), { env: { ...env, NO_PROXY: '*' }, systemProxy: null })).toBeNull();
    // <local> 只放行无点主机名
    expect(resolveProxyFor(new URL('https://localhost/'), { env: { ...env, NO_PROXY: '<local>' }, systemProxy: null })).toBeNull();
    expect(resolveProxyFor(new URL('https://example.com/'), { env: { ...env, NO_PROXY: '<local>' }, systemProxy: null })?.hostname).toBe('p');
    // 不在列表里 → 照常走代理
    expect(resolveProxyFor(new URL('https://other.test/'), { env: { ...env, NO_PROXY: 'internal' }, systemProxy: null })?.hostname).toBe('p');
  });

  it('falls back to the system proxy when no env var is set (the Windows case)', () => {
    const p = resolveProxyFor(new URL('https://huggingface.co/x'), { env: {}, systemProxy: sys });
    expect(p?.hostname).toBe('127.0.0.1');
    expect(p?.port).toBe('7897');
  });

  it('returns null when the system proxy is disabled or absent', () => {
    expect(resolveProxyFor(new URL('https://x.test/'), { env: {}, systemProxy: null })).toBeNull();
  });

  it('reads a per-scheme WinINET list and its ProxyOverride bypass', () => {
    const list = { server: 'http=h1:1;https=h2:2', override: 'skipme' };
    expect(resolveProxyFor(new URL('https://x.test/'), { env: {}, systemProxy: list })?.port).toBe('2');
    expect(resolveProxyFor(new URL('http://x.test/'), { env: {}, systemProxy: list })?.port).toBe('1');
    expect(resolveProxyFor(new URL('https://skipme/'), { env: {}, systemProxy: list })).toBeNull();
  });

  it('exposes the small parsers directly', () => {
    expect(pickProxyServer('h:1', 'https')).toBe('h:1');
    expect(pickProxyServer('http=h1:1;https=h2:2', 'https')).toBe('h2:2');
    expect(pickProxyServer('http=h1:1;https=h2:2', 'http')).toBe('h1:1');
    expect(pickProxyServer('   ', 'http')).toBeNull();
    expect(isBypassed('a.example.com', 'example.com')).toBe(true);
    expect(isBypassed('a.example.com', '.example.com')).toBe(true);
    expect(isBypassed('notexample.com', 'example.com')).toBe(false);
  });
});

/* ── 端到端（真 socket）── */

describe('fetchUrl', () => {
  /** 一个只会说「代理语」的极简 HTTP 代理：转发绝对 URI 请求 */
  async function startProxy(): Promise<{ port: number; seen: string[] }> {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      const target = new URL(req.url ?? '');
      const up = http.request(
        { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET' },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
      up.end();
    });
    const port = await listen(server);
    return { port, seen };
  }

  async function startOrigin(): Promise<number> {
    const server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
        res.end(Buffer.alloc(10 * 1024 * 1024));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello through the proxy');
    });
    return listen(server);
  }

  it('fetches directly when no proxy is configured', async () => {
    const origin = await startOrigin();
    const r = await fetchUrl(`http://127.0.0.1:${origin}/ok`, { proxy: { env: {}, systemProxy: null } });
    expect(r.ok).toBe(true);
    expect(r.bytes.toString()).toBe('hello through the proxy');
    expect(r.contentType).toBe('text/plain');
  });

  it('routes the request through the proxy when one is configured', async () => {
    const origin = await startOrigin();
    const proxy = await startProxy();
    const r = await fetchUrl(`http://127.0.0.1:${origin}/via-proxy`, {
      proxy: { env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, systemProxy: null },
    });
    expect(r.ok).toBe(true);
    expect(r.bytes.toString()).toBe('hello through the proxy');
    // 关键断言：请求确实是被**代理**转发的（绝对 URI 形态）
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toContain('/via-proxy');
    expect(proxy.seen[0].startsWith('http://')).toBe(true);
  });

  it('follows redirects itself when going through a proxy', async () => {
    const origin = await new Promise<number>((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: '/end' });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end('landed');
      });
      void listen(server).then(resolve);
    });
    const proxy = await startProxy();
    const r = await fetchUrl(`http://127.0.0.1:${origin}/start`, {
      proxy: { env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, systemProxy: null },
    });
    expect(r.status).toBe(200);
    expect(r.bytes.toString()).toBe('landed');
    expect(r.finalUrl).toContain('/end');
  });

  it('enforces the byte cap', async () => {
    const origin = await startOrigin();
    await expect(
      fetchUrl(`http://127.0.0.1:${origin}/big`, { maxBytes: 1024, proxy: { env: {}, systemProxy: null } }),
    ).rejects.toThrow(/too large/);
  });

  it('reports a non-2xx status as not ok (the caller decides what to say)', async () => {
    const origin = await new Promise<number>((resolve) => {
      const server = http.createServer((_req, res) => { res.writeHead(404); res.end('nope'); });
      void listen(server).then(resolve);
    });
    const r = await fetchUrl(`http://127.0.0.1:${origin}/missing`, { proxy: { env: {}, systemProxy: null } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe('connectTunnel', () => {
  it('sends a CONNECT for the target authority and resolves on 200', async () => {
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.once('data', (buf) => {
        seen.push(buf.toString('latin1').split('\r\n')[0]);
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        // 隧道建立后不转发，只为验证握手与解析
      });
    });
    const port = await listen(server);
    const target = new URL('https://example.com/some/path');
    const socket = await connectTunnel(new URL(`http://127.0.0.1:${port}`), target);
    expect(seen[0]).toBe('CONNECT example.com:443 HTTP/1.1');
    socket.destroy();
  });

  it('rejects with the proxy status when the tunnel is refused', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
        socket.end();
      });
    });
    const port = await listen(server);
    await expect(
      connectTunnel(new URL(`http://127.0.0.1:${port}`), new URL('https://blocked.test/')),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('reports an unreachable proxy instead of hanging', async () => {
    // 端口 1 上不会有代理
    await expect(
      connectTunnel(new URL('http://127.0.0.1:1'), new URL('https://x.test/')),
    ).rejects.toThrow(/unreachable/);
  });
});
