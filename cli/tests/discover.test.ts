import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainOf, freePort, init, pop, tempDataDir } from './helpers.js';

/**
 * practi 的 hub 发现面（2026-11-25）：`ls --remote`（我的实例）、`search --remote`（公开浏览/检索
 * + 我的）、`clone <name>`（owner 由登录账号补全）。本地 mock hub 打桩三个端点
 * （GET /api/v1/instances、GET /api/v1/search/instances、GET /api/auth/me）与实例视图，
 * 凭据直写配置家——与其他 hub 桥集成测试同构。
 */

const ME = 'tester';

type Row = Record<string, unknown>;

let server: http.Server;
let baseUrl: string;
let myRows: Row[];
let publicRows: Row[];
/** false = 旧版 hub：发现端点还不存在（404） */
let searchSupported: boolean;
/** 发现端点收到的查询串（按调用顺序） */
let searchQueries: string[];
/** 发现端点的每次调用是否带了 Authorization（公开浏览/检索必须匿名） */
let searchAuthed: boolean[];

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function mine(name: string, visibility: string, extra: Row = {}): Row {
  return {
    id: `id-${name}`,
    name,
    owner_account: ME,
    description: null,
    visibility,
    head_hash: null,
    head_name: null,
    head_content: null,
    head_status: null,
    revision_count: 1,
    updated_at: '2026-11-20T03:00:00.000Z',
    ...extra,
  };
}

function pub(owner: string, name: string, title: string, extra: Row = {}): Row {
  return {
    owner,
    name,
    description: null,
    head_name: title,
    head_content: null,
    updated_at: '2026-11-21T03:00:00.000Z',
    revision_count: 2,
    ...extra,
  };
}

beforeAll(async () => {
  const port = await freePort();
  myRows = [];
  publicRows = [];
  searchSupported = true;
  searchQueries = [];
  searchAuthed = [];
  server = http.createServer((req, res) => {
    const authed = (req.headers.authorization ?? '').startsWith('Bearer mock-');
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = u.pathname;
    if (p === '/api/v1/search/instances') {
      searchQueries.push(u.search);
      searchAuthed.push(authed);
      if (!searchSupported) {
        respond(res, 404, { error: 'Not found', code: 'E_NOT_FOUND' });
        return;
      }
      // 与 hub 同款：整串子串匹配（大小写不敏感）；q 为空 = 全量浏览
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const results = publicRows.filter((r) => q === '' || `${String(r.name)} ${String(r.head_name)}`.toLowerCase().includes(q));
      respond(res, 200, { results, total: results.length });
      return;
    }
    if (!authed) {
      respond(res, 401, { error: 'unauthorized' });
      return;
    }
    if (p === '/api/auth/me') {
      respond(res, 200, { username: ME });
      return;
    }
    if (p === '/api/v1/instances' && req.method === 'GET') {
      respond(res, 200, { results: myRows });
      return;
    }
    const view = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)$/.exec(p);
    if (view && req.method === 'GET') {
      const row = myRows.find((r) => r.name === view[2]);
      if (!row || view[1] !== ME) {
        respond(res, 404, { error: 'Instance not found', code: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      respond(res, 200, {
        name: row.name,
        visibility: row.visibility,
        branch: 'main',
        branch_head_hash: null,
        revisions: [],
      });
      return;
    }
    respond(res, 404, { error: `no route: ${req.method} ${p}` });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

/** mock hub + 已登录凭据的配置家；anonymous=true 时只配 remote 不写凭据 */
async function hubHome(anonymous = false): Promise<string> {
  const dir = tempDataDir();
  await init(dir);
  const rs = await pop(dir, ['remote', 'set', baseUrl]);
  if (rs.code !== 0) throw new Error(`remote set failed: ${rs.stderr}`);
  if (!anonymous) {
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
  }
  return dir;
}

describe('practi ls --remote：我在 hub 上的实践', () => {
  it('表格：可见性标签（public/private/reviewing）、版本数、更新日期、头标题；页脚给数量与账号', async () => {
    const home = await hubHome();
    myRows = [
      mine('deploy-next', 'PUBLIC', { head_name: 'Deploy Next.js', revision_count: 12 }),
      mine('training-plan', 'PRIVATE', { head_name: '按周训练', revision_count: 3 }),
      mine('ci-check', 'PUBLIC_REVIEWING'),
      mine('long-title', 'PRIVATE', { head_name: `t${'x'.repeat(100)}`, revision_count: 1 }),
      mine('empty-one', 'PRIVATE', { revision_count: 0 }),
    ];
    const r = await pop(home, ['ls', '--remote']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/name\s+visibility\s+revs\s+updated\s+head/);
    const lines = r.stdout.split('\n');
    expect(lines.find((l) => l.startsWith('deploy-next'))).toMatch(/public\s+12\s+2026-11-20\s+Deploy Next\.js$/);
    expect(lines.find((l) => l.startsWith('training-plan'))).toMatch(/private\s+3\s+2026-11-20\s+按周训练$/);
    expect(lines.find((l) => l.startsWith('ci-check'))).toMatch(/reviewing\s+1\s+2026-11-20/);
    expect(lines.find((l) => l.startsWith('long-title'))).toMatch(/^long-title\s+private\s+1\s+2026-11-20\s+tx{78}…$/); // 标题截到 80 字符（101 字符 → 前 79 + 省略号）
    expect(lines.find((l) => l.startsWith('empty-one'))).toMatch(/\(no revision yet\)$/);
    expect(r.stdout).toMatch(/5 practice\(s\) on the hub as tester — .*`practi clone <name>`/);
  });

  it('--json：owner/name/visibility/title/description/revisions/updated 逐行', async () => {
    const home = await hubHome();
    myRows = [mine('deploy-next', 'PUBLIC', { head_name: 'Deploy Next.js', description: '部署到阿里云', revision_count: 12 })];
    const r = await pop(home, ['ls', '--remote', '--json']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      {
        owner: ME,
        name: 'deploy-next',
        visibility: 'PUBLIC',
        title: 'Deploy Next.js',
        description: '部署到阿里云',
        revisions: 12,
        updated: '2026-11-20T03:00:00.000Z',
      },
    ]);
  });

  it('空列表：空态提示（exit 0）；未登录 → 1；未配置 remote 也先被未登录拦下（默认 practihub.com，不联网）', async () => {
    const home = await hubHome();
    myRows = [];
    const empty = await pop(home, ['ls', '--remote']);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/no practices on the hub yet/);

    const anon = await hubHome(true);
    const noLogin = await pop(anon, ['ls', '--remote']);
    expect(noLogin.code).toBe(1);
    expect(noLogin.stderr).toMatch(/not logged in/);

    // 2026-11-27 起未配置 remote 回落默认 https://practihub.com：凭据检查在联网之前
    // （authedFetch → requireCredentials 先抛），所以裸配置家 + 无凭据在这里就被拦下，
    // 绝不真的去连 practihub.com
    const bare = tempDataDir();
    await init(bare);
    const noRemote = await pop(bare, ['ls', '--remote']);
    expect(noRemote.code).toBe(1);
    expect(noRemote.stderr).toMatch(/not logged in/);
    expect(noRemote.stderr).not.toMatch(/no remote configured/);
  });
});

describe('practi search --remote：公开实践浏览/检索 + 我的', () => {
  it('不带词 = 浏览最近更新的公开实践：匿名请求（不带 q），页脚指向 ls --remote', async () => {
    const home = await hubHome(); // 已登录也必须匿名——公开面不依赖登录态
    publicRows = [pub('alice', 'deploy-ssr', 'Deploy an SSR app'), pub('bob', 'ci-checklist', 'CI deploy checklist')];
    searchQueries = [];
    searchAuthed = [];
    const r = await pop(home, ['search', '--remote', '--limit', '5']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(searchQueries).toHaveLength(1);
    const q = new URLSearchParams(searchQueries[0]!);
    expect(q.has('q')).toBe(false);
    expect(q.get('limit')).toBe('5');
    expect(searchAuthed).toEqual([false]);
    expect(r.stdout).toMatch(/public practices on the hub, newest first/);
    expect(r.stdout).toMatch(/alice\/deploy-ssr\s+Deploy an SSR app$/m);
    expect(r.stdout).toMatch(/2 shown — .*`practi clone <owner>\/<name>`; your own: `practi ls --remote`/);
  });

  it('未登录：只列公开命中，并提示登录可并入自己的；零命中时同样提示', async () => {
    const home = await hubHome(true);
    publicRows = [pub('alice', 'deploy-ssr', 'Deploy-ssr guide', { description: 'Deploy an SSR app' })];
    searchQueries = [];
    const hit = await pop(home, ['search', '--remote', 'deploy']);
    expect(hit.code, `stderr=${hit.stderr}`).toBe(0);
    expect(new URLSearchParams(searchQueries[0]!).get('q')).toBe('deploy');
    expect(hit.stdout).toMatch(/^public\n {2}alice\/deploy-ssr\s+Deploy-ssr guide\n {2} +Deploy an SSR app$/m);
    expect(hit.stdout).not.toMatch(/^mine$/m);
    expect(hit.stdout).toMatch(/1 matched — /);
    expect(hit.stdout).toMatch(/log in with `practi login` to include your own practices/);

    const miss = await pop(home, ['search', '--remote', 'nothing-matches-this']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toMatch(/no practices on the hub match "nothing-matches-this"/);
    expect(miss.stdout).toMatch(/log in with `practi login`/);
  });

  it('已登录：我的排前面（带可见性），公开在后；我自己已公开的在两边都命中时只列一次', async () => {
    const home = await hubHome();
    myRows = [
      mine('deploy-next', 'PRIVATE', { head_name: 'Deploy Next.js' }),
      mine('shared-deploy', 'PUBLIC', { head_name: 'Shared deploy guide' }),
      mine('training-plan', 'PRIVATE', { description: '部署后的训练安排' }),
    ];
    publicRows = [pub('alice', 'deploy-ssr', 'Deploy SSR guide'), pub(ME, 'shared-deploy', 'Shared deploy guide')];
    const r = await pop(home, ['search', '--remote', 'deploy']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    const lines = r.stdout.split('\n');
    const mineAt = lines.indexOf('mine');
    const publicAt = lines.indexOf('public');
    expect(mineAt).toBeGreaterThan(-1);
    expect(publicAt).toBeGreaterThan(mineAt);
    expect(lines.filter((l) => l.includes('shared-deploy'))).toHaveLength(1);
    expect(lines[mineAt + 1]).toMatch(/^ {2}tester\/deploy-next\s+private\s+Deploy Next\.js$/);
    expect(lines[mineAt + 2]).toMatch(/^ {2}tester\/shared-deploy\s+public\s+Shared deploy guide$/);
    // 「我的」按名字/标题/描述匹配：training-plan 的描述不含 deploy，不应出现
    expect(lines[publicAt + 1]).toMatch(/^ {2}alice\/deploy-ssr\s+Deploy SSR guide$/);
    expect(r.stdout).toMatch(/3 matched — /);
    expect(r.stdout).not.toMatch(/log in with/);
  });

  it('多词 = AND：拆词各查一次再取交集（hub 按整串匹配，连着写会漏）', async () => {
    const home = await hubHome(true);
    publicRows = [pub('bob', 'ci-checklist', 'CI deploy checklist'), pub('alice', 'deploy-ssr', 'Deploy SSR guide')];
    searchQueries = [];
    const r = await pop(home, ['search', '--remote', 'checklist', 'deploy']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(searchQueries.map((s) => new URLSearchParams(s).get('q'))).toEqual(['checklist', 'deploy']);
    expect(r.stdout).toMatch(/bob\/ci-checklist/);
    expect(r.stdout).not.toMatch(/deploy-ssr/);
    expect(r.stdout).toMatch(/1 matched/);
  });

  it('--json：query/mode/results（mine 旗标）/public_total', async () => {
    const home = await hubHome();
    myRows = [mine('deploy-next', 'PRIVATE', { head_name: 'Deploy Next.js' })];
    publicRows = [pub('alice', 'deploy-ssr', 'Deploy SSR guide')];
    const r = await pop(home, ['search', '--remote', 'deploy', '--json']);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      query: string;
      mode: string;
      results: { owner: string; name: string; mine: boolean; visibility: string }[];
      public_total: number;
    };
    expect(parsed.query).toBe('deploy');
    expect(parsed.mode).toBe('search');
    expect(parsed.results.map((x) => `${x.owner}/${x.name}:${x.mine}`)).toEqual(['tester/deploy-next:true', 'alice/deploy-ssr:false']);
    expect(parsed.results[0]!.visibility).toBe('PRIVATE');
    expect(parsed.public_total).toBe(1);

    const browse = JSON.parse((await pop(home, ['search', '--remote', '--json'])).stdout) as {
      query: string;
      mode: string;
      results: unknown[];
      public_total: number;
    };
    expect(browse).toMatchObject({ query: '', mode: 'browse', public_total: 1 });
    expect(browse.results).toHaveLength(1);
  });

  it('旧版 hub（发现端点 404）→ 1，并说明需要的 hub 版本', async () => {
    const home = await hubHome(true);
    searchSupported = false;
    const r = await pop(home, ['search', '--remote', 'deploy']);
    searchSupported = true;
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cannot list or search its practices yet — it needs practihub v0\.2\.22/);
  });
});

describe('practi clone <name>：owner 由登录账号补全', () => {
  it('已登录：按 <我>/<name> 取实例，链文件记下 owner', async () => {
    const home = await hubHome();
    myRows = [mine('empty-one', 'PRIVATE')];
    const dir = path.join(tempDataDir(), 'empty-one');
    const r = await pop(home, ['clone', 'empty-one', '--dir', dir]);
    expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/cloned:\s+tester\/empty-one/);
    expect(chainOf(dir)).toMatchObject({ name: 'empty-one', owner: ME, current: 'main' });
  });

  it('未登录 → 1 并说明两种走法；我名下没有这个名字 → 1、说明去哪找，且不留空文件夹', async () => {
    const anon = await hubHome(true);
    const noLogin = await pop(anon, ['clone', 'empty-one', '--dir', path.join(tempDataDir(), 'a')]);
    expect(noLogin.code).toBe(1);
    expect(noLogin.stderr).toMatch(/takes one of your own practices — run `practi login` first, or give the full <owner>\/<name>/);

    const home = await hubHome();
    myRows = [];
    const parent = tempDataDir();
    const missing = await pop(home, ['clone', 'no-such-one', '--dir', path.join(parent, 'b')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/looked under your account \(tester\/no-such-one\); another owner's practice needs `practi clone <owner>\/<name>`/);
    expect(fs.existsSync(path.join(parent, 'b'))).toBe(false);
  });
});
