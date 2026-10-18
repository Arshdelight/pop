import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { createdRoot, freePort, init, pop, readState, tempDataDir } from './helpers.js';

/**
 * hub 桥集成测试（login 除外）：本地 mock hub 打桩全部端点，凭据直写 practi.auth.json
 * （OAuth 授权页要真浏览器，不进 CI）。覆盖 instance create/bind、branch/switch、
 * push 存文档+绑支头（含 E_NOT_FAST_FORWARD）、merge 快进与 squash 双路径、log、pull。
 */

const DOC = { name: 'Hub bridge doc', content: 'Content that travels to the hub.' };
const ME = { username: 'tester' };

interface MockState {
  /** PUT branches/:b/head 对该 hash 返回 422（模拟分叉），其余放行 */
  rejectBindFor: string | null;
  /** mock 里 feat 支的头（测试可改写，squash 场景指到本地工作区的真文档） */
  featHead: string;
  /** mine 端点追加返回的认领（pull 测试用；push 的 diff 基准随之变化） */
  mineExtra: string | null;
  storeCalls: number;
  bindCalls: { branch: string; root_hash: string }[];
  createdBranches: { name: string; from_hash?: string }[];
  deletedBranches: string[];
}

let server: http.Server;
let baseUrl: string;
let mock: MockState;

const MAIN_HEAD = 'sha256:' + '1'.repeat(64);
const ALLOWED_BRANCHES = ['main', 'feat'];

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  const port = await freePort();
  mock = { rejectBindFor: null, featHead: 'sha256:' + 'f'.repeat(64), mineExtra: null, storeCalls: 0, bindCalls: [], createdBranches: [], deletedBranches: [] };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer mock-')) {
      respond(res, 401, { error: 'unauthorized' });
      return;
    }
    if (p === '/api/auth/me') {
      respond(res, 200, ME);
      return;
    }
    if (p === '/api/v1/instances' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name: string; visibility?: string };
      respond(res, 201, { id: 'inst-1', name: body.name, visibility: body.visibility ?? 'PRIVATE' });
      return;
    }
    if (p === '/api/v1/pop/mine') {
      respond(res, 200, { results: mock.mineExtra ? [{ root_hash: mock.mineExtra, status: 'PRIVATE' }] : [], total: mock.mineExtra ? 1 : 0 });
      return;
    }
    if (p === '/api/v1/pop' && req.method === 'POST') {
      mock.storeCalls++;
      const doc = JSON.parse(await readBody(req)) as { name?: string };
      const root = parseDocument(doc).rootHash;
      respond(res, 201, { root_hash: root, status: 'PRIVATE', idempotent: false });
      return;
    }
    const docMatch = /^\/api\/v1\/pop\/([^/]+)$/.exec(p);
    if (docMatch && req.method === 'GET') {
      // pull：文档体必须让客户端验算出同一 root——直接回 DOC 的真身（ref 是 URL 编码的）
      const ref = decodeURIComponent(docMatch[1]);
      const parsed = parseDocument(DOC);
      if (ref === parsed.rootHash) {
        respond(res, 200, { document: DOC, status: 'PRIVATE' });
      } else {
        respond(res, 404, { error: 'not found' });
      }
      return;
    }
    const instMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)(\/branches(\/([^/]+))?(\/head)?)?$/.exec(p);
    if (instMatch) {
      // 分组：1=owner 2=name 3=branches 段 4=（含斜杠的支名） 5=支名 6=/head——解构跳过 4
      const [, owner, name, branchSeg, , branchName, headSeg] = instMatch;
      if (owner !== ME.username) {
        respond(res, 404, { error: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      if (!branchSeg) {
        const wanted = url.searchParams.get('branch') ?? 'main';
        if (!ALLOWED_BRANCHES.includes(wanted)) {
          respond(res, 404, { error: 'branch not found', code: 'E_BRANCH_NOT_FOUND' });
          return;
        }
        respond(res, 200, {
          name,
          visibility: 'PRIVATE',
          owner: { account: owner },
          branch: wanted,
          branch_head_hash: wanted === 'feat' ? mock.featHead : MAIN_HEAD,
          branches: [
            { name: 'main', head_hash: MAIN_HEAD, is_default: true },
            { name: 'feat', head_hash: mock.featHead, is_default: false },
          ],
          revisions: [
            { seq: 2, root_hash: mock.featHead, created_at: '2026-10-18T00:00:00Z', name: 'second', status: 'PRIVATE', missing: false },
            { seq: 1, root_hash: MAIN_HEAD, created_at: '2026-10-17T00:00:00Z', name: 'first', status: 'PRIVATE', missing: false },
          ],
        });
        return;
      }
      // branchSeg 捕获的是 /branches 起的整段（贪婪外层组），条件按整段形式比较
      if (branchSeg === '/branches' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { name: string; from_hash?: string };
        mock.createdBranches.push(body);
        respond(res, 201, { ok: true, name: body.name, head_hash: body.from_hash ?? null });
        return;
      }
      if (branchName && branchSeg === `/branches/${branchName}` && req.method === 'DELETE') {
        mock.deletedBranches.push(decodeURIComponent(branchName));
        respond(res, 200, { ok: true });
        return;
      }
      if (branchName && branchSeg === `/branches/${branchName}/head` && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { root_hash: string };
        mock.bindCalls.push({ branch: decodeURIComponent(branchName), root_hash: body.root_hash });
        if (mock.rejectBindFor !== null && body.root_hash === mock.rejectBindFor) {
          respond(res, 422, { error: 'not fast forward', code: 'E_NOT_FAST_FORWARD' });
          return;
        }
        respond(res, 200, { ok: true, head_hash: body.root_hash, branch: decodeURIComponent(branchName) });
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

/** mock hub + 已登录凭据 + 已绑实例的一次性工作区 */
async function hubWorkspace(): Promise<string> {
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
      scope: 'pop:read pop:write pop:publish pop:delete',
      client_name: 'practi cli',
      access_token: 'mock-access',
      refresh_token: 'mock-refresh',
      expires_at: Date.now() + 3_600_000,
    }),
  );
  return dir;
}

describe('practi hub bridge: instance', () => {
  it('instance create 建实例并绑定（owner=me，branch main）', async () => {
    const dir = await hubWorkspace();
    const out = await pop(dir, ['instance', 'create', 'my-practice', '--desc', 'test instance']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/created and bound: tester\/my-practice \(PRIVATE, branch main\)/);
    expect(readState(dir).instance).toEqual({ owner: 'tester', name: 'my-practice', branch: 'main' });
  });

  it('instance bind <owner>/<name> 绑既有实例；坏 ref 报 usage', async () => {
    const dir = await hubWorkspace();
    const bad = await pop(dir, ['instance', 'bind', 'no-slash']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/usage: practi instance bind/);

    const out = await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/bound: tester\/my-practice/);
    expect(readState(dir).instance?.branch).toBe('main');
  });

  it('instance show 显示绑定概要', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const out = await pop(dir, ['instance', 'show']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/instance:  tester\/my-practice/);
    expect(out.stdout).toMatch(/revisions: 2 \(on main\)/);
  });
});

describe('practi hub bridge: branch / switch', () => {
  it('branch 建支/列表/-d 删支；switch 切换并写回 practi.json', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);

    const list = await pop(dir, ['branch']);
    expect(list.stdout).toMatch(/^\* main/m);
    expect(list.stdout).toMatch(/^  feat/m);

    const create = await pop(dir, ['branch', 'quick-fix']);
    expect(create.code).toBe(0);
    expect(create.stdout).toMatch(/created branch: quick-fix/);
    expect(mock.createdBranches.at(-1)).toEqual({ name: 'quick-fix' });

    const sw = await pop(dir, ['switch', 'feat']);
    expect(sw.code).toBe(0);
    expect(sw.stdout).toMatch(/switched to branch: feat/);
    expect(readState(dir).instance?.branch).toBe('feat');

    const del = await pop(dir, ['branch', '-d', 'quick-fix']);
    expect(del.code).toBe(0);
    expect(mock.deletedBranches).toContain('quick-fix');
  });

  it('switch 不存在的支 → 报错且不写 practi.json', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const out = await pop(dir, ['switch', 'nope']);
    expect(out.code).toBe(1);
    expect(readState(dir).instance?.branch).toBe('main');
  });
});

describe('practi hub bridge: push', () => {
  it('push 存文档并绑分支头（单 direct 免参猜头）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);

    const out = await pop(dir, ['push']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`pushed:  ${root}`));
    expect(out.stdout).toMatch(new RegExp(`bound:   tester/my-practice@main → ${root}`));
    expect(mock.bindCalls.at(-1)).toEqual({ branch: 'main', root_hash: root });
  });

  it('push --branch 覆盖绑定支；E_NOT_FAST_FORWARD → 提示 merge/rebase 退出 1', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);

    mock.rejectBindFor = root;
    try {
      const out = await pop(dir, ['push', root, '--branch', 'feat']);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/pushed:/);
      expect(out.stderr).toMatch(/bind failed.*merge or rebase first/);
      expect(mock.bindCalls.at(-1)).toEqual({ branch: 'feat', root_hash: root });
    } finally {
      mock.rejectBindFor = null;
    }
  });

  it('未绑实例=纯认领推送（提示不猜头）', async () => {
    const dir = await hubWorkspace();
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    const before = mock.storeCalls;
    const bindsBefore = mock.bindCalls.length;
    const out = await pop(dir, ['push']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/stored as direct claims only/);
    expect(mock.storeCalls).toBe(before + 1);
    expect(mock.bindCalls).toHaveLength(bindsBefore);
  });
});

describe('practi hub bridge: merge', () => {
  it('快进合并：纯移指针零新文档', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    // mock 的 feat 头=sha256:ff..，bind 放行（rejectBindFor=null）=FF 语义
    const storesBefore = mock.storeCalls;
    const out = await pop(dir, ['merge', 'feat']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/fast-forward: main → f{12}/);
    expect(out.stdout).toMatch(/\(merged feat\)/);
    expect(mock.storeCalls).toBe(storesBefore); // FF 零新文档
  });

  it('分叉合并：本地构造 squash 修订（store→bind）并提示 pull 同步', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    // feat 头指到本地工作区的真文档（squash 需要本地拿得到 tip 树），并对它拒绑一次=分叉
    mock.featHead = root;
    mock.rejectBindFor = root;
    try {
      const out = await pop(dir, ['merge', 'feat']);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/merged \(squash\): feat → main as [0-9a-f]{12}/);
      expect(out.stdout).toMatch(/practi pull [0-9a-f]{12}/);
      const lastBind = mock.bindCalls.at(-1);
      expect(lastBind?.branch).toBe('main');
      expect(lastBind?.root_hash).not.toBe(root); // squash 修订是新哈希
    } finally {
      mock.rejectBindFor = null;
      mock.featHead = 'sha256:' + 'f'.repeat(64);
    }
  });
});

describe('practi hub bridge: log / pull', () => {
  it('log 列当前支历史（tip 在前）；--json 出结构', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const out = await pop(dir, ['log']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^v2\s+f{12}\s+2026-10-18\s+PRIVATE\s+second/m);
    expect(out.stdout).toMatch(/^v1\s+1{12}\s+2026-10-17\s+PRIVATE\s+first/m);

    const j = await pop(dir, ['log', '--json', '--branch', 'feat']);
    const parsed = JSON.parse(j.stdout) as { branch: string; revisions: unknown[] };
    expect(parsed.branch).toBe('feat');
    expect(parsed.revisions).toHaveLength(2);
  });

  it('pull 拉远端文档入库为 direct（内容寻址验算过闸）', async () => {
    const dir = await hubWorkspace();
    const root = parseDocument(DOC).rootHash;
    mock.mineExtra = root; // ref 定位走 mine 认领表
    try {
      const out = await pop(dir, ['pull', root.slice(0, 12)]);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(new RegExp(`pulled:  ${root}`));
      expect(readState(dir).direct).toContain(root);
      expect(fs.existsSync(path.join(dir, 'nodes', root.slice('sha256:'.length) + '.md'))).toBe(true);
    } finally {
      mock.mineExtra = null;
    }
  });
});
