import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePort, init, pop, tempDataDir } from './helpers.js';

/**
 * practi notifications（2026-11-18）：hub 信箱查询（最近 N / since-until 时间窗 / --json）。
 * 本地 mock hub 打桩 /api/v1/notifications（捕获查询串），凭据直写配置家——与其他 hub 桥
 * 集成测试同构。只读命令：不断言已读状态变化（标记已读在 hub web 端）。
 */

interface NotificationRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

let server: http.Server;
let baseUrl: string;
let lastQuery = '';
let notificationsBody: { unread: number; items: NotificationRow[] };

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  const port = await freePort();
  notificationsBody = { unread: 0, items: [] };
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer mock-')) {
      respond(res, 401, { error: 'unauthorized' });
      return;
    }
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (u.pathname === '/api/v1/notifications') {
      lastQuery = u.search;
      respond(res, 200, notificationsBody);
      return;
    }
    respond(res, 404, { error: `no route: ${req.method} ${u.pathname}` });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

/** mock hub + 已登录凭据的配置家（同 hub.test.ts 的 hubHome） */
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

function row(partial: Partial<NotificationRow>): NotificationRow {
  return {
    id: partial.id ?? 'n1',
    kind: partial.kind ?? 'pop_approved',
    payload: partial.payload ?? { name: 'My practice' },
    readAt: partial.readAt ?? null,
    createdAt: partial.createdAt ?? '2026-11-18T06:30:00.000Z',
  };
}

describe('practi notifications：hub 信箱查询', () => {
  it('human 输出：未读标记/kind 标签/name/reason；无参数不带头查询串', async () => {
    const home = await hubHome();
    notificationsBody = {
      unread: 1,
      items: [
        row({ id: 'a', kind: 'pop_rejected', payload: { name: 'My practice', reason: '命中违规描述' } }),
        row({ id: 'b', kind: 'pop_approved', readAt: '2026-11-18T07:00:00.000Z' }),
      ],
    };
    const r = await pop(home, ['notifications']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('2 notification(s), unread: 1');
    expect(r.stdout).toMatch(/\*\s+.*rejected\s+: My practice — 命中违规描述/);
    expect(r.stdout).toContain('approved');
    expect(lastQuery).toBe('');
  });

  it('limit + 日期窗归一：YYYY-MM-DD → UTC 全日窗（until 补到次日零点，hub 端 lt）', async () => {
    const home = await hubHome();
    notificationsBody = { unread: 0, items: [] };
    const r = await pop(home, ['notifications', '-n', '5', '--since', '2026-11-01', '--until', '2026-11-03']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    const q = new URLSearchParams(lastQuery);
    expect(q.get('limit')).toBe('5');
    expect(q.get('since')).toBe('2026-11-01T00:00:00.000Z');
    expect(q.get('until')).toBe('2026-11-04T00:00:00.000Z');
    expect(r.stdout).toMatch(/no notifications in the given range/);
  });

  it('--json 原样结构（unread + items）；空信箱零查询也有可读输出', async () => {
    const home = await hubHome();
    notificationsBody = { unread: 2, items: [row({ id: 'j1', kind: 'issue_created', payload: { name: 'X' } })] };
    const r = await pop(home, ['notifications', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { unread: number; items: NotificationRow[] };
    expect(parsed.unread).toBe(2);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].kind).toBe('issue_created');
  });

  it('非法日期 → 1 + stderr 指引；未配置 remote → 1', async () => {
    const home = await hubHome();
    const bad = await pop(home, ['notifications', '--since', 'not-a-date']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/invalid --since/);

    const bare = tempDataDir();
    await init(bare);
    const noRemote = await pop(bare, ['notifications']);
    expect(noRemote.code).toBe(1);
    expect(noRemote.stderr).toMatch(/no remote configured/);
  });
});
