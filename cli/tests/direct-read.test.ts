import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { freePort, init, pop, runIn, tempDataDir, chainOf, workingFile, writeDoc } from './helpers.js';

/**
 * 直读面（2026-11-27）：带 `<owner>/<name>[@branch]` 地址直接操作 hub——
 * `show` / `log` 的远程模式（读视图定位支头、取修订、验根渲染/列历史）与新命令
 * `set`（PATCH 实例元数据），以及配置面（未配置 remote 回落默认、init/config 退役）。
 * 本地 mock hub 打桩三个端点（GET 实例视图、GET 修订、PATCH 实例），凭据直写配置家——
 * 与 hub.test.ts 同构。全部走 127.0.0.1，不碰真实网络。
 */

/* 文档按导出形态书写（带 type——真实 hub 上的文档就是工作文件的 exportSubtree 形态），
 * 这样 show --doc 的 exportSubtree 往返与 hub 返回逐字段相等 */
const DOC1 = { type: 'action', name: 'Direct read first', content: 'The first revision body.' };
const DOC2 = { type: 'action', name: 'Direct read second', content: 'The second revision body.' };
const DOC3 = { type: 'action', name: 'Tampered impostor', content: 'Not what the address says.' };
/** 在实例上、但不在支的可见列表里的版本（完整哈希直取路径用） */
const DOC_UNLISTED = { type: 'action', name: 'Unlisted revision', content: 'On the instance, not in the visible list.' };

interface Revision {
  seq: number;
  root_hash: string;
  parent_hash: string | null;
  message: string;
  created_at: string;
  status: string;
}

let server: http.Server;
let baseUrl: string;
let docs: Map<string, unknown>;
let chain: Revision[];
let patchBodies: Record<string, unknown>[];
/** 非空时修订端点返回这份冒名文档（验根失败路径） */
let tamperDoc: unknown;

const OWNER = 'tester';
const NAME = 'direct-p';

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  const port = await freePort();
  const r1 = parseDocument(DOC1).rootHash;
  const r2 = parseDocument(DOC2).rootHash;
  docs = new Map([
    [r1, DOC1],
    [r2, DOC2],
    [parseDocument(DOC_UNLISTED).rootHash, DOC_UNLISTED],
  ]);
  chain = [
    { seq: 2, root_hash: r2, parent_hash: r1, message: 'second revision', created_at: '2026-11-26T10:00:00.000Z', status: 'PRIVATE' },
    { seq: 1, root_hash: r1, parent_hash: null, message: 'first revision', created_at: '2026-11-25T09:00:00.000Z', status: 'PRIVATE' },
  ];
  patchBodies = [];
  tamperDoc = null;
  server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer mock-')) {
      respond(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;

    if (p === '/api/auth/me') {
      respond(res, 200, { username: OWNER });
      return;
    }
    const revMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)\/revisions\/([^/]+)$/.exec(p);
    if (revMatch && req.method === 'GET') {
      const [, owner, name, hash] = revMatch;
      if (owner !== OWNER || name !== NAME) {
        respond(res, 404, { error: 'Instance not found', code: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      const ref = decodeURIComponent(hash);
      if (tamperDoc !== null) {
        respond(res, 200, { root_hash: ref, document: tamperDoc, status: 'PRIVATE' });
        return;
      }
      const doc = docs.get(ref);
      if (doc !== undefined) {
        respond(res, 200, { root_hash: ref, document: doc, status: 'PRIVATE' });
      } else {
        respond(res, 404, { error: 'Revision not found', code: 'E_REVISION_NOT_FOUND' });
      }
      return;
    }
    const instMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)$/.exec(p);
    if (instMatch) {
      const [, owner, name] = instMatch;
      if (owner !== OWNER || name !== NAME) {
        respond(res, 404, { error: 'Instance not found', code: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        patchBodies.push(body);
        respond(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET') {
        const wanted = url.searchParams.get('branch');
        if (wanted !== null && wanted !== 'main') {
          respond(res, 404, { error: `Branch "${wanted}" not found`, code: 'E_BRANCH_NOT_FOUND' });
          return;
        }
        respond(res, 200, {
          name: NAME,
          description: 'Served straight from the mock hub',
          visibility: 'PRIVATE',
          refines: null,
          owner: { account: OWNER },
          branches: [{ name: 'main', head_hash: chain[0]?.root_hash ?? null, is_default: true }],
          branch: 'main',
          branch_head_hash: chain[0]?.root_hash ?? null,
          revisions: chain,
        });
        return;
      }
    }
    respond(res, 404, { error: `no route: ${req.method} ${p}` });
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

const r1 = parseDocument(DOC1).rootHash;
const r2 = parseDocument(DOC2).rootHash;

describe('show 直读 hub', () => {
  it('默认输出与「clone 后本地 show」的 stdout 逐字相同', async () => {
    const cloned = await hubHome();
    const parent = tempDataDir();
    const c = await runIn(parent, cloned, ['clone', `${OWNER}/${NAME}`]);
    expect(c.code, `stdout=${c.stdout} stderr=${c.stderr}`).toBe(0);
    const repo = path.join(parent, NAME);
    expect(chainOf(repo).commits).toHaveLength(2);
    const local = await runIn(repo, cloned, ['show', r2]);
    expect(local.code, `stderr=${local.stderr}`).toBe(0);

    const fresh = await hubHome();
    const remote = await pop(fresh, ['show', `${OWNER}/${NAME}`]);
    expect(remote.code, `stderr=${remote.stderr}`).toBe(0);
    expect(remote.stdout).toBe(local.stdout);
    expect(remote.stdout).toContain('Direct read second');
  });

  it('--doc 输出等于 hub 返回的文档；支头时 stderr 提示 --base，stdout 保持纯 JSON', async () => {
    const home = await hubHome();
    const out = await pop(home, ['show', `${OWNER}/${NAME}`, '--doc']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(DOC2);
    expect(out.stderr).toMatch(/v2, the branch head/);
    expect(out.stderr).toMatch(/--base v2/);
  });

  it('hub 回来的文档验根不符 → 退出 1，stdout 一个字都不打', async () => {
    const home = await hubHome();
    tamperDoc = DOC3;
    try {
      const out = await pop(home, ['show', `${OWNER}/${NAME}`]);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(/hash mismatch/);
    } finally {
      tamperDoc = null;
    }
  });

  it('--rev v1 出旧版本；--doc 旧版提示它不是头；前缀哈希同路', async () => {
    const home = await hubHome();
    const old = await pop(home, ['show', `${OWNER}/${NAME}`, '--rev', 'v1']);
    expect(old.code).toBe(0);
    expect(old.stdout).toContain('Direct read first');
    expect(old.stdout).not.toContain('Direct read second');

    const oldDoc = await pop(home, ['show', `${OWNER}/${NAME}`, '--rev', 'v1', '--doc']);
    expect(oldDoc.code).toBe(0);
    expect(JSON.parse(oldDoc.stdout)).toEqual(DOC1);
    expect(oldDoc.stderr).toMatch(/not the branch head \(head: v2\)/);
    expect(oldDoc.stderr).not.toMatch(/--base/);

    const byPrefix = await pop(home, ['show', `${OWNER}/${NAME}`, '--rev', r1.slice('sha256:'.length, 'sha256:'.length + 12), '--doc']);
    expect(byPrefix.code).toBe(0);
    expect(JSON.parse(byPrefix.stdout)).toEqual(DOC1);
  });

  it('--rev 给完整哈希：不在支的可见列表里也直接取，由 hub 说了算', async () => {
    const home = await hubHome();
    const out = await pop(home, ['show', `${OWNER}/${NAME}`, '--rev', parseDocument(DOC_UNLISTED).rootHash, '--doc']);
    expect(out.code, `stderr=${out.stderr}`).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(DOC_UNLISTED);
    // 不知道它是不是头：不打支头提示
    expect(out.stderr).not.toMatch(/branch head/);
  });

  it('实例不存在 → hub 404 透传', async () => {
    const home = await hubHome();
    const out = await pop(home, ['show', `${OWNER}/no-such`]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/HTTP 404/);
  });
});

describe('log 直读 hub', () => {
  it('人类输出沿用本地行格式、行尾日期；--limit 截断提示', async () => {
    const home = await hubHome();
    const out = await pop(home, ['log', `${OWNER}/${NAME}`]);
    expect(out.code, `stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`v2\\s+${r2.slice(7, 19)}\\s+second revision\\s+2026-11-26`));
    expect(out.stdout).toMatch(new RegExp(`v1\\s+${r1.slice(7, 19)}\\s+first revision\\s+2026-11-25`));

    const lim = await pop(home, ['log', `${OWNER}/${NAME}`, '--limit', '1']);
    expect(lim.code).toBe(0);
    expect(lim.stdout).toMatch(/v2\s+\S+\s+second revision/);
    expect(lim.stdout).not.toMatch(/v1/);
    // 截断行报的是还剩几条（2 条里只显示 1 条）
    expect(lim.stdout).toMatch(/\.\.\. 1 more \(use --limit\)/);
  });

  it('--json 出 practice/branch/revisions（seq/root_hash/parent_hash/message/created_at/status）', async () => {
    const home = await hubHome();
    const js = await pop(home, ['log', `${OWNER}/${NAME}`, '--json']);
    expect(js.code).toBe(0);
    expect(JSON.parse(js.stdout)).toEqual({
      practice: `${OWNER}/${NAME}`,
      branch: 'main',
      revisions: chain.map((c) => ({
        seq: c.seq,
        root_hash: c.root_hash,
        parent_hash: c.parent_hash,
        message: c.message,
        created_at: c.created_at,
        status: c.status,
      })),
    });
  });

  it('位置参数不带 / → 报错（不再静默忽略）', async () => {
    const home = await hubHome();
    const bad = await pop(home, ['log', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/usage: practi log/);
  });
});

describe('set：PATCH 实例元数据', () => {
  it('body 只含给过的字段；成功打印改了什么；改名补打新地址', async () => {
    const home = await hubHome();
    patchBodies = [];

    const one = await pop(home, ['set', `${OWNER}/${NAME}`, '--description', 'fresh text']);
    expect(one.code, `stderr=${one.stderr}`).toBe(0);
    expect(one.stdout).toMatch(/updated tester\/direct-p/);
    expect(one.stdout).toMatch(/description → fresh text/);
    expect(one.stdout).not.toMatch(/new address/);
    expect(patchBodies).toEqual([{ description: 'fresh text' }]);

    const two = await pop(home, ['set', `${OWNER}/${NAME}`, '--name', 'renamed-p', '--refines', r1]);
    expect(two.code).toBe(0);
    expect(two.stdout).toMatch(/name → renamed-p/);
    expect(two.stdout).toMatch(/new address: tester\/renamed-p/);
    expect(patchBodies[1]).toEqual({ name: 'renamed-p', refines: r1 });

    const clear = await pop(home, ['set', `${OWNER}/${NAME}`, '--description', '']);
    expect(clear.code).toBe(0);
    expect(clear.stdout).toMatch(/description cleared/);
    expect(patchBodies[2]).toEqual({ description: '' });
    expect(patchBodies[2] && 'name' in patchBodies[2]).toBe(false);

    const clearEdge = await pop(home, ['set', `${OWNER}/${NAME}`, '--refines', '']);
    expect(clearEdge.code).toBe(0);
    expect(clearEdge.stdout).toMatch(/refines cleared/);
    expect(patchBodies[3]).toEqual({ refines: null });
  });

  it('一个字段都不给 → 用法 + 退出 1，不发请求', async () => {
    const home = await hubHome();
    patchBodies = [];
    const none = await pop(home, ['set', `${OWNER}/${NAME}`]);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/nothing to set/);
    expect(none.stderr).toMatch(/usage: practi set/);
    expect(patchBodies).toHaveLength(0);
  });

  it('hub 404 → 报错退出 1；裸 <name> 不是地址', async () => {
    const home = await hubHome();
    const nf = await pop(home, ['set', `${OWNER}/missing-p`, '--name', 'x']);
    expect(nf.code).toBe(1);
    expect(nf.stderr).toMatch(/HTTP 404/);

    const bare = await pop(home, ['set', NAME, '--name', 'x']);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toMatch(/<owner>\/<name>/);
  });
});

describe('配置面', () => {
  it('me 未登录：打出配置家与默认 remote（标明 default），并提示 practi login', async () => {
    const bare = tempDataDir();
    const me = await pop(bare, ['me']);
    expect(me.code).toBe(1);
    expect(me.stdout).toMatch(/config home: /);
    expect(me.stdout).toContain('remote:     https://practihub.com');
    expect(me.stdout).toContain('(default');
    expect(me.stdout).not.toContain('(set with');
    expect(me.stderr).toMatch(/not logged in — run `practi login` first/);
  });

  it('init / config：退役指引 + 退出 1', async () => {
    const bare = tempDataDir();
    const ir = await pop(bare, ['init']);
    expect(ir.code).toBe(1);
    expect(ir.stderr).toMatch(/`practi init` was retired/);
    expect(ir.stderr).toMatch(/`practi me`/);

    const cr = await pop(bare, ['config']);
    expect(cr.code).toBe(1);
    expect(cr.stderr).toMatch(/`practi config` was retired/);
  });

  it('clone 后工作文件在（直读不依赖本地文件夹的对照面）', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const c = await runIn(parent, home, ['clone', `${OWNER}/${NAME}`]);
    expect(c.code).toBe(0);
    const repo = path.join(parent, NAME);
    expect(fs.existsSync(workingFile(repo))).toBe(true);
    expect((JSON.parse(fs.readFileSync(workingFile(repo), 'utf8')) as { name: string }).name).toBe(DOC2.name);
  });
});
