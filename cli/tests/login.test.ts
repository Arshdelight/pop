import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { init, pop, tempDataDir, type PopResult } from './helpers.js';

/**
 * practi login 的 client 登记复用（2026-11-27 用户拍板）：hub 上每次登录都 DCR 一条新
 * 登记、旧登记从不删除——改 CLI 按 remote 复用已登记的 client_id，hub 一行不改。
 * 本地 mock hub 打桩 OAuth 端点（register / client-info / token / revoke；well-known 不打
 * 桩，discoverAs 按约定路径回退）。浏览器一步由测试扮演：从 --no-open 打印的授权 URL 里
 * 取 redirect_uri 与 state，直打 CLI 自己起的 loopback 回调。登记数按“用例开始时快照 +
 * 增量”断言，不靠等待。
 */

const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;
const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = path.join(CLI_ROOT, 'src', 'index.ts');
const SCOPES = 'practice:read practice:write practice:delete';

/* ── mock hub ── */

/** client-info 的应答姿态：ok=按 knownClients 认；gone=一律 404 Client not found；error=500 */
type InfoMode = 'ok' | 'gone' | 'error';

interface MockHub {
  server: http.Server;
  baseUrl: string;
  /** /register 发出的 client_id，按序 */
  registrations: string[];
  /** client-info 认为存在的 id（register 发出的 + 测试手动种的老登记） */
  knownClients: Set<string>;
  infoMode: InfoMode;
  lastTokenRequest: Record<string, string> | null;
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function createMockHub(): Promise<MockHub> {
  return new Promise((resolve) => {
    const hub: MockHub = {
      server: undefined as unknown as http.Server,
      baseUrl: '',
      registrations: [],
      knownClients: new Set<string>(),
      infoMode: 'ok',
      lastTokenRequest: null,
    };
    const server = http.createServer((req, res) => {
      void (async () => {
        const u = new URL(req.url ?? '/', 'http://mock.local');
        const p = u.pathname;
        if (req.method === 'GET' && p === '/api/auth/oauth/client-info') {
          const id = u.searchParams.get('client_id') ?? '';
          if (hub.infoMode === 'gone') return respond(res, 404, { error: 'Client not found' });
          if (hub.infoMode === 'error') return respond(res, 500, { error: 'boom' });
          if (hub.knownClients.has(id)) return respond(res, 200, { clientId: id, name: 'practi cli', scope: SCOPES });
          return respond(res, 404, { error: 'Client not found' });
        }
        if (req.method === 'POST' && p === '/api/auth/oauth/register') {
          await readBody(req);
          const id = `client-${hub.registrations.length + 1}`;
          hub.registrations.push(id);
          hub.knownClients.add(id);
          return respond(res, 200, { client_id: id });
        }
        if (req.method === 'POST' && p === '/api/auth/oauth/token') {
          hub.lastTokenRequest = Object.fromEntries(new URLSearchParams(await readBody(req)));
          return respond(res, 200, {
            access_token: 'mock-access',
            refresh_token: 'mock-refresh',
            expires_in: 3600,
            scope: SCOPES,
          });
        }
        if (req.method === 'POST' && p === '/api/auth/oauth/revoke') {
          await readBody(req);
          return respond(res, 200, {});
        }
        return respond(res, 404, { error: 'not found' });
      })().catch(() => respond(res, 500, { error: 'mock failure' }));
    });
    hub.server = server;
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      hub.baseUrl = `http://127.0.0.1:${port}`;
      resolve(hub);
    });
  });
}

/* ── 驱动一次登录：起 CLI 子进程 → 抓授权 URL → 扮浏览器打回调 → 收结果 ── */

interface LoginRun {
  child: ChildProcess;
  done: Promise<PopResult>;
  /** --no-open 模式打印的授权 URL */
  url: Promise<string>;
}

function spawnLogin(home: string, args: string[] = []): LoginRun {
  let settleDone: (r: PopResult) => void = () => {};
  const done = new Promise<PopResult>((resolve) => {
    settleDone = resolve;
  });
  const child = execFile(
    process.execPath,
    ['--import', TSX_LOADER, CLI_ENTRY, 'login', '--no-open', ...args, '--data-dir', home],
    {
      cwd: CLI_ROOT,
      env: { ...process.env, PRACTI_HOME: home, PRACTI_NO_VERSION_CHECK: '1' },
      windowsHide: true,
      timeout: 60_000,
      killSignal: 'SIGKILL',
    },
    (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      settleDone({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    },
  );
  child.stdin?.on('error', () => {}); // EPIPE when the child never reads — fine
  child.stdin?.end('');

  let out = '';
  const url = new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/open this URL in your browser:\s*(\S+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', () => reject(new Error(`login exited before printing the authorize URL\n--- stdout ---\n${out}`)));
  });
  return { child, done, url };
}

/** 扮浏览器：按授权 URL 里的 redirect_uri + state 打 CLI 的 loopback 回调 */
async function browserCallback(authorizeUrl: string): Promise<void> {
  const u = new URL(authorizeUrl);
  const redirect = u.searchParams.get('redirect_uri');
  const state = u.searchParams.get('state');
  if (redirect === null || state === null) throw new Error(`authorize URL lacks redirect_uri/state: ${authorizeUrl}`);
  const res = await fetch(`${redirect}?code=${encodeURIComponent('auth-code-e2e')}&state=${encodeURIComponent(state)}`);
  if (res.status !== 200) throw new Error(`loopback callback expected 200, got ${res.status}`);
}

async function driveLogin(home: string, args: string[] = []): Promise<PopResult & { authorizeUrl: string }> {
  const run = spawnLogin(home, args);
  const authorizeUrl = await run.url;
  await browserCallback(authorizeUrl);
  const result = await run.done;
  return { ...result, authorizeUrl };
}

/* ── 断言用的小读盘工具 ── */

function registryOf(home: string): { schema: number; clients: Record<string, { client_id: string; registered_at: string }> } {
  return JSON.parse(fs.readFileSync(path.join(home, 'practi.client.json'), 'utf8'));
}

function credsOf(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, 'practi.auth.json'), 'utf8')) as Record<string, unknown>;
}

/** 空配置家：init + remote set，不写任何凭据/登记 */
async function freshHome(baseUrl: string): Promise<string> {
  const dir = tempDataDir();
  await init(dir);
  const rs = await pop(dir, ['remote', 'set', baseUrl]);
  if (rs.code !== 0) throw new Error(`remote set failed: ${rs.stderr}`);
  return dir;
}

/* ── 套件 ── */

let hub!: MockHub;
const extraServers: http.Server[] = [];

beforeAll(async () => {
  hub = await createMockHub();
});

beforeEach(() => {
  hub.infoMode = 'ok';
  hub.tokenMode = 'ok';
  hub.lastTokenRequest = null;
});

afterAll(async () => {
  for (const s of [hub.server, ...extraServers]) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('practi login（client 登记复用）', () => {
  it('首次登录：登记恰好一次并记账，登记文件与凭据同一个 client_id', async () => {
    const home = await freshHome(hub.baseUrl);
    expect(fs.existsSync(path.join(home, 'practi.client.json'))).toBe(false);
    const before = hub.registrations.length;

    const rs = await driveLogin(home);

    expect(rs.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 1);
    const clientId = hub.registrations[before];
    const reg = registryOf(home);
    expect(reg.schema).toBe(1);
    expect(reg.clients[hub.baseUrl].client_id).toBe(clientId);
    expect(typeof reg.clients[hub.baseUrl].registered_at).toBe('string');
    expect(credsOf(home).client_id).toBe(clientId);
  });

  it('登出后再登录与 --reauth：不再登记，授权与换令牌都带已存的 client_id', async () => {
    const home = await freshHome(hub.baseUrl);
    const before = hub.registrations.length;
    const first = await driveLogin(home);
    expect(first.code).toBe(0);
    const clientId = hub.registrations[before];

    const out = await pop(home, ['logout']);
    expect(out.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 1); // 登出删凭据，不动登记

    const second = await driveLogin(home);
    expect(second.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 1);
    expect(new URL(second.authorizeUrl).searchParams.get('client_id')).toBe(clientId);
    expect(hub.lastTokenRequest?.client_id).toBe(clientId);

    const third = await driveLogin(home, ['--reauth']);
    expect(third.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 1);
    expect(new URL(third.authorizeUrl).searchParams.get('client_id')).toBe(clientId);
    expect(hub.lastTokenRequest?.client_id).toBe(clientId);
    expect(credsOf(home).client_id).toBe(clientId);
  });

  it('登记后放弃（回调未到被杀）：登记已落盘，下次登录复用，登记数仍为 1', async () => {
    const home = await freshHome(hub.baseUrl);
    const before = hub.registrations.length;

    const run = spawnLogin(home);
    const authorizeUrl = await run.url;
    expect(new URL(authorizeUrl).searchParams.get('client_id')).toBe(hub.registrations[before]);
    run.child.kill('SIGKILL'); // 模拟用户中途放弃：等回调这一步提前收场
    const killed = await run.done;
    expect(killed.code).not.toBe(0);

    expect(hub.registrations).toHaveLength(before + 1); // 打开浏览器之前登记已发生并落盘
    expect(registryOf(home).clients[hub.baseUrl].client_id).toBe(hub.registrations[before]);

    const rs = await driveLogin(home); // 下一次登录复用，不再登记
    expect(rs.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 1);
    expect(new URL(rs.authorizeUrl).searchParams.get('client_id')).toBe(hub.registrations[before]);
    expect(credsOf(home).client_id).toBe(hub.registrations[before]);
  });

  it('服务端已没有这条登记（client-info 404 Client not found）：丢弃旧登记、重新登记、流程照常成功', async () => {
    const home = await freshHome(hub.baseUrl);
    const before = hub.registrations.length;
    const first = await driveLogin(home);
    expect(first.code).toBe(0);
    const staleId = hub.registrations[before];

    hub.infoMode = 'gone';
    const rs = await driveLogin(home, ['--reauth']);

    expect(rs.code).toBe(0);
    expect(hub.registrations).toHaveLength(before + 2); // 旧登记被丢，重新登记一条
    const freshId = hub.registrations[before + 1];
    expect(freshId).not.toBe(staleId);
    expect(registryOf(home).clients[hub.baseUrl].client_id).toBe(freshId);
    expect(credsOf(home).client_id).toBe(freshId);
  });

  it('老用户升级：有凭据（同 resource）无登记文件，--reauth 后不新登记，登记里是旧凭据的 client_id', async () => {
    const home = await freshHome(hub.baseUrl);
    const before = hub.registrations.length;
    hub.knownClients.add('legacy-client-2007'); // hub 上确实还有这条旧登记
    fs.writeFileSync(
      path.join(home, 'practi.auth.json'),
      JSON.stringify({
        schema: 1,
        client_id: 'legacy-client-2007',
        resource: `${hub.baseUrl}/cli`,
        scope: SCOPES,
        client_name: 'practi cli',
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        expires_at: Date.now() + 3_600_000,
      }),
    );

    const rs = await driveLogin(home, ['--reauth']);

    expect(rs.code).toBe(0);
    expect(hub.registrations).toHaveLength(before); // 没有新登记
    expect(registryOf(home).clients[hub.baseUrl].client_id).toBe('legacy-client-2007');
    expect(credsOf(home).client_id).toBe('legacy-client-2007');
    expect(new URL(rs.authorizeUrl).searchParams.get('client_id')).toBe('legacy-client-2007');
    expect(hub.lastTokenRequest?.client_id).toBe('legacy-client-2007');
  });

  it('两个 remote 各自登记互不影响：换 hub 各记各的，切回复用旧登记', async () => {
    const hubB = await createMockHub();
    extraServers.push(hubB.server);
    const home = await freshHome(hub.baseUrl); // remote set 会剥尾部斜杠，两个 remote 必须真不同源
    const beforeA = hub.registrations.length;
    const beforeB = hubB.registrations.length;

    const first = await driveLogin(home);
    expect(first.code).toBe(0);
    const cidA = hub.registrations[beforeA];

    expect((await pop(home, ['remote', 'set', hubB.baseUrl])).code).toBe(0); // 换 hub 清凭据，登记不动
    const second = await driveLogin(home);
    expect(second.code).toBe(0);
    expect(hubB.registrations).toHaveLength(beforeB + 1);
    const cidB = hubB.registrations[beforeB];
    expect(hub.registrations).toHaveLength(beforeA + 1); // A 的登记没动

    expect((await pop(home, ['remote', 'set', hub.baseUrl])).code).toBe(0);
    const third = await driveLogin(home);
    expect(third.code).toBe(0);
    expect(hub.registrations).toHaveLength(beforeA + 1); // 切回复用 A 的旧登记，不重登
    expect(hubB.registrations).toHaveLength(beforeB + 1);
    expect(new URL(third.authorizeUrl).searchParams.get('client_id')).toBe(cidA);
    expect(credsOf(home).client_id).toBe(cidA);

    const reg = registryOf(home);
    expect(Object.keys(reg.clients).sort()).toEqual([hub.baseUrl, hubB.baseUrl].sort());
    expect(reg.clients[hub.baseUrl].client_id).toBe(cidA);
    expect(reg.clients[hubB.baseUrl].client_id).toBe(cidB);
  });
});
