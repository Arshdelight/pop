import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, init, pop, runIn, tempDataDir } from './helpers.js';

/**
 * 用户行为面命令组（2026-11-19，practi 从工具面补齐 hub 用户行为）：
 * appeal submit/list（审核申诉，服务端解析肇事 pop）、visibility public|private（实例可见性，
 * pop#1）。本地 mock hub 打桩端点，凭据直写配置家（同 hub.test.ts 模式）。
 */

const ROOT = 'sha256:' + 'a'.repeat(64);

let server: http.Server;
let baseUrl: string;
let last: { method: string; path: string; body: Record<string, unknown> } | null = null;

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** mock hub + 已登录凭据的配置家（每测试独立 home，互不串状态） */
async function hubHome(): Promise<string> {
  const dir = tempDataDir();
  await init(dir);
  const rs = await pop(dir, ['remote', 'set', baseUrl]);
  if (rs.code !== 0) throw new Error(`remote set failed: ${rs.stderr}`);
  fs.writeFileSync(
    path.join(dir, 'practi.auth.json'),
    JSON.stringify({
      schema: 1,
      client_id: 'mock-client',
      resource: `${baseUrl}/cli`,
      scope: 'practice:read practice:write practice:delete',
      client_name: 'practi cli',
      access_token: 'mock-access',
      refresh_token: 'mock-refresh',
      expires_at: Date.now() + 3_600_000,
    }),
  );
  return dir;
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = http.createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer mock-')) {
        respond(res, 401, { error: 'unauthorized' });
        return;
      }
      const p = (req.url ?? '').split('?')[0];
      const bodyText = ['POST', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : '';
      last = { method: req.method ?? '', path: p, body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {} };

      if (req.method === 'POST' && p === '/api/v1/instances/liz/thing/appeals') {
        respond(res, 201, { id: 'ticket-1' });
        return;
      }
      if (req.method === 'GET' && p === '/api/v1/instances/liz/thing/appeals') {
        respond(res, 200, {
          items: [
            {
              id: 'ticket-1',
              root_hash: ROOT,
              status: 'PENDING',
              decision_note: null,
              created_at: '2026-11-19T00:00:00.000Z',
              handled_at: null,
            },
          ],
          head: { root_hash: ROOT, review_result: null, review_note: null },
        });
        return;
      }
      if (req.method === 'PATCH' && p === '/api/v1/instances/liz/thing') {
        respond(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && p === '/api/v1/instances/liz/thing') {
        respond(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE' && p === '/api/v1/instances/liz/other') {
        respond(res, 403, { error: 'missing scope', code: 'E_SCOPE' });
        return;
      }
      respond(res, 404, { error: 'not found' });
    })().catch(() => respond(res, 500, { error: 'mock failure' }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
});

afterAll(() => {
  server.close();
});

describe('appeal（审核申诉）', () => {
  it('submit：POST {rootHash, reason}，受理回执带工单号', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['appeal', 'submit', 'liz/thing', '--root', ROOT, '--reason', '自有运维，机审误判']);
    expect(rs.code).toBe(0);
    expect(last?.path).toBe('/api/v1/instances/liz/thing/appeals');
    expect(last?.body).toMatchObject({ rootHash: ROOT, reason: '自有运维，机审误判' });
    expect(rs.stdout).toContain('ticket ticket-1');
  });

  it('submit：裸 64-hex 自动补 sha256: 前缀', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['appeal', 'submit', 'liz/thing', '--root', 'a'.repeat(64), '--reason', 'x']);
    expect(rs.code).toBe(0);
    expect(last?.body).toMatchObject({ rootHash: ROOT });
  });

  it('submit：缺 --root / 缺 --reason 拒绝', async () => {
    const home = await hubHome();
    expect((await pop(home, ['appeal', 'submit', 'liz/thing', '--reason', 'x'])).code).toBe(1);
    expect((await pop(home, ['appeal', 'submit', 'liz/thing', '--root', ROOT])).code).toBe(1);
  });

  it('list：申诉单 + 头审核态', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['appeal', 'list', 'liz/thing']);
    expect(rs.code).toBe(0);
    expect(rs.stdout).toContain('NOT_REVIEWED');
    expect(rs.stdout).toContain('PENDING');
    expect(rs.stdout).toContain(ROOT.slice(0, 17));
  });
});

describe('visibility（实例可见性，pop#1）', () => {
  it('public：PATCH {visibility:"PUBLIC"} + 受理提示', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['visibility', 'liz/thing', 'public']);
    expect(rs.code).toBe(0);
    expect(last?.method).toBe('PATCH');
    expect(last?.path).toBe('/api/v1/instances/liz/thing');
    expect(last?.body).toMatchObject({ visibility: 'PUBLIC' });
    expect(rs.stdout).toContain('PUBLIC_REVIEWING');
  });

  it('private：PATCH {visibility:"PRIVATE"}', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['visibility', 'liz/thing', 'private']);
    expect(rs.code).toBe(0);
    expect(last?.body).toMatchObject({ visibility: 'PRIVATE' });
  });

  it('非法模式拒绝', async () => {
    const home = await hubHome();
    expect((await pop(home, ['visibility', 'liz/thing', 'draft'])).code).toBe(1);
  });
});

describe('delete（删 hub 实例）', () => {
  it('--yes：DELETE 实例端点', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['delete', 'liz/thing', '--yes']);
    expect(rs.code).toBe(0);
    expect(last?.method).toBe('DELETE');
    expect(last?.path).toBe('/api/v1/instances/liz/thing');
    expect(rs.stdout).toContain('deleted: liz/thing');
  });

  it('缺 --yes 不发请求', async () => {
    const home = await hubHome();
    last = null;
    const rs = await pop(home, ['delete', 'liz/thing']);
    expect(rs.code).toBe(1);
    expect(last).toBeNull();
    expect(rs.stdout).toContain('permanently deletes');
  });

  it('凭据缺 practice:delete scope 时本地拦下并指路 reauth', async () => {
    const home = await hubHome();
    const f = path.join(home, 'practi.auth.json');
    const creds = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(f, JSON.stringify({ ...creds, scope: 'practice:read practice:write' }));
    last = null;
    const rs = await pop(home, ['delete', 'liz/thing', '--yes']);
    expect(rs.code).toBe(1);
    expect(last).toBeNull();
    expect(rs.stderr).toContain('login --reauth');
  });

  it('hub 拒绝时报状态码与错误码，不动本地', async () => {
    const home = await hubHome();
    const rs = await pop(home, ['delete', 'liz/other', '--yes']);
    expect(rs.code).toBe(1);
    expect(rs.stderr).toContain('HTTP 403 (E_SCOPE)');
  });

  it('--local：删 hub 成功后移除同名实践文件夹', async () => {
    const home = await hubHome();
    const dir = path.join(tempDataDir(), 'thing');
    const rs0 = await runIn(path.dirname(dir), home, ['new', 'thing', '--dir', dir]);
    expect(rs0.code).toBe(0);
    const rs = await pop(home, ['delete', 'liz/thing', '--yes', '--local', dir]);
    expect(rs.code).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('--local：文件夹不是同名实践时拒删，且不发请求', async () => {
    const home = await hubHome();
    const dir = path.join(tempDataDir(), 'else');
    await init(dir);
    last = null;
    const rs = await pop(home, ['delete', 'liz/thing', '--yes', '--local', dir]);
    expect(rs.code).toBe(1);
    expect(last).toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
  });
});
