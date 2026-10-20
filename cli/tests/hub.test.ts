import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { freePort, init, pop, tempDataDir } from './helpers.js';

/**
 * hub 桥集成测试（双软件模型，2026-10-20）：本地 mock hub 打桩端点，凭据直写
 * practi.auth.json。覆盖 practice new/list/remove、publish（pop→实例新修订+推 hub）、
 * push（首推创建/FF/up-to-date/分叉报错/--force）、branch/switch（本地链）、
 * merge（FF/指针移动）、history（reword/squash/reset）、log（本地链）、clone/pull、
 * fetch（单拉 POP 入 pops 区）。
 */

const DOC = { name: 'Hub bridge doc', content: 'Content that travels to the hub.' };
const DOC2 = { name: 'Second pop', content: 'Another pop for the practice.' };
const ME = { username: 'tester' };

interface MockState {
  /** GET 实例视图的 main 链覆盖（[0] 视为 tip；[] = 空实例） */
  mainChain: { seq: number; root_hash: string; parent_hash: string | null }[] | null;
  /** revisions?force=1 的回执 dropped 数 */
  forceDropped: number;
  /** 最近一次 POST revisions 的提交说明 */
  lastMessage: string | null;
  /** force 端点收到的链（断言用） */
  lastForceCommits: { seq: number; root_hash: string; parent_hash: string | null; message: string }[] | null;
  /** CLI 对远端缺失的支自动建支的记录（真实 hub：显式未知支名视图 404，建支后重取） */
  createdBranches: string[];
  remoteDocs: Map<string, unknown>;
  storeCalls: number;
  forceCalls: number;
  createdInstances: { name: string; visibility?: string }[];
}

let server: http.Server;
let baseUrl: string;
let mock: MockState;

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
  mock = {
    mainChain: [],
    forceDropped: 0,
    lastMessage: null,
    lastForceCommits: null,
    createdBranches: [],
    remoteDocs: new Map(),
    storeCalls: 0,
    forceCalls: 0,
    createdInstances: [],
  };
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
      mock.createdInstances.push(body);
      respond(res, 201, { id: 'inst-1', name: body.name, visibility: body.visibility ?? 'PRIVATE', owner: ME.username });
      return;
    }
    const revMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)\/revisions\/([^/]+)$/.exec(p);
    if (revMatch && req.method === 'GET') {
      const [, revOwner, , ref] = revMatch;
      if (revOwner !== ME.username) {
        respond(res, 404, { error: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      const doc = mock.remoteDocs.get(decodeURIComponent(ref));
      if (doc !== undefined) {
        respond(res, 200, { document: doc, status: 'PRIVATE' });
      } else {
        respond(res, 404, { error: 'not found' });
      }
      return;
    }
    const instMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)(\/branches(\/([^/]+))?(\/(head|revisions))?)?$/.exec(p);
    if (instMatch) {
      const [, owner, name, branchSeg, , branchName] = instMatch;
      if (owner !== ME.username) {
        respond(res, 404, { error: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      if (!branchSeg) {
        const wanted = url.searchParams.get('branch') ?? 'main';
        // 真实 hub 契约：显式支名必须存在，未知支名诚实 404（E_BRANCH_NOT_FOUND）
        if (!['main', ...mock.createdBranches].includes(wanted)) {
          respond(res, 404, { error: `Branch "${wanted}" not found`, code: 'E_BRANCH_NOT_FOUND' });
          return;
        }
        const chain = (mock.mainChain ?? []).map((c) => ({
          ...c,
          message: `v${c.seq}`,
          created_at: '2026-10-20T00:00:00Z',
          name: `v${c.seq}`,
        }));
        respond(res, 200, {
          name,
          visibility: 'PRIVATE',
          owner: { account: owner },
          branch: wanted,
          branch_head_hash: chain[0]?.root_hash ?? null,
          branches: [{ name: 'main', head_hash: chain[0]?.root_hash ?? null, is_default: true }],
          revisions: chain.map((c) => ({ ...c, status: 'PRIVATE', missing: false })),
        });
        return;
      }
      if (branchSeg === '/branches' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { name: string };
        mock.createdBranches.push(body.name);
        respond(res, 201, { name: body.name, head_hash: null, is_default: false });
        return;
      }
      if (branchName && branchSeg === `/branches/${branchName}/revisions` && req.method === 'POST') {
        if (url.searchParams.get('force') === '1') {
          const body = JSON.parse(await readBody(req)) as {
            commits: { seq: number; root_hash: string; parent_hash: string | null; message: string }[];
          };
          mock.forceCalls++;
          mock.lastForceCommits = body.commits;
          respond(res, 200, { ok: true, head: body.commits.at(-1)?.root_hash ?? null, dropped: mock.forceDropped });
          return;
        }
        const body = JSON.parse(await readBody(req)) as { document: unknown; message?: string };
        const root = parseDocument(body.document).rootHash;
        mock.storeCalls++;
        mock.lastMessage = body.message ?? null;
        respond(res, 201, { root_hash: root, status: 'PRIVATE', branch: decodeURIComponent(branchName), seq: mock.storeCalls });
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

/** mock hub + 已登录凭据的一次性工作区 */
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
      scope: 'practice:read practice:write practice:delete',
      client_name: 'practi cli',
      access_token: 'mock-access',
      refresh_token: 'mock-refresh',
      expires_at: Date.now() + 3_600_000,
    }),
  );
  return dir;
}

function chainOf(dir: string, name: string): { branches: Record<string, string | null>; commits: { seq: number; root: string; parent: string | null; message: string; pushedAt?: string }[]; owner: string | null; current: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'practices', name, 'chain.json'), 'utf8'));
}

describe('practice new / list / remove（本地实例仓库）', () => {
  it('practice new 登记 registry 实例（chain.json 落盘，main 空支）', async () => {
    const dir = await hubWorkspace();
    const out = await pop(dir, ['practice', 'new', 'my-practice']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/created practice: my-practice/);
    const chain = chainOf(dir, 'my-practice');
    expect(chain.name).toBe('my-practice');
    expect(chain.owner).toBeNull();
    expect(chain.branches).toEqual({ main: null });
    expect(chain.commits).toEqual([]);

    const list = await pop(dir, ['practice', 'list']);
    expect(list.stdout).toMatch(/my-practice/);
  });

  it('practice remove 撤本地登记；hub 不被触碰（零网络调用计数不变）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'gone']);
    const out = await pop(dir, ['practice', 'remove', 'gone']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/removed practice: gone/);
    expect(fs.existsSync(path.join(dir, 'practices', 'gone'))).toBe(false);
    const list = await pop(dir, ['practice', 'list']);
    expect(list.stdout).toMatch(/no practices/);
  });
});

describe('publish：pop → 实例新修订 + 推 hub', () => {
  it('publish --to 首推：链登记+hub 创建实例+FF 推送+pops 原稿移除', async () => {
    const dir = await hubWorkspace();
    const root = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;

    const out = await pop(dir, ['publish', root, '--to', 'my-practice']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`published: Hub bridge doc.*my-practice@main.*v1.*${root.slice(7, 19)}`));
    // hub：实例创建 + FF 存文档
    expect(mock.createdInstances).toEqual([{ name: 'my-practice', visibility: 'PRIVATE' }]);
    expect(mock.storeCalls).toBe(1);
    // chain.json：owner 回填+提交登记+支头
    const chain = chainOf(dir, 'my-practice');
    expect(chain.owner).toBe('tester');
    expect(chain.commits).toHaveLength(1);
    expect(chain.commits[0].root).toBe(root);
    expect(chain.commits[0].pushedAt).toBeDefined();
    expect(chain.branches.main).toBe(root);
    // pops 原稿移除（移入实例后游离副本清掉；pop 文档以实例修订身份存在）
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(st.direct).not.toContain(root);
  });

  it('publish --keep 保留 pops 原稿', async () => {
    const dir = await hubWorkspace();
    const root = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    const out = await pop(dir, ['publish', root, '--to', 'my-practice', '--keep']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/kept:/);
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(st.direct).toContain(root);
  });

  it('publish 文件路径直达：不经 pops，任意目录的 pop 文件发布进实例', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'my-practice']);
    const file = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(file, JSON.stringify(DOC2), 'utf8');
    const before = mock.storeCalls;
    const out = await pop(dir, ['publish', file, '--to', 'my-practice']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/published: Second pop/);
    expect(mock.storeCalls).toBe(before + 1);
  });
});

describe('push：首推创建 / up to date / 分叉与 --force', () => {
  it('push 首推创建实例并推链；重推=up to date', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'solo']);
    const root = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    const pub = await pop(dir, ['publish', root, '--to', 'solo', '--keep']);
    expect(pub.code).toBe(0);

    // 再推：hub 视图反映推后的链 → up to date
    mock.mainChain = [{ seq: 1, root_hash: root, parent_hash: null }];
    try {
      const out = await pop(dir, ['push', '--practice', 'solo']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/up to date/);
    } finally {
      mock.mainChain = [];
    }
  });

  it('分叉：hub 头不在本地链 → 报错；--force 走全链端点且报 dropped', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'solo']);
    const root = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root, '--to', 'solo', '--keep']);

    // hub 头在别处（不认识本地链）
    mock.mainChain = [{ seq: 3, root_hash: 'sha256:' + '9'.repeat(64), parent_hash: null }];
    try {
      const rejected = await pop(dir, ['push', '--practice', 'solo']);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toMatch(/diverged/);
      expect(rejected.stderr).toMatch(/--force/);
      expect(mock.forceCalls).toBe(0);

      const forced = await pop(dir, ['push', '--practice', 'solo', '--force']);
      expect(forced.code, `stdout=${forced.stdout} stderr=${forced.stderr}`).toBe(0);
      expect(forced.stdout).toMatch(/forced:/);
      expect(mock.forceCalls).toBe(1);
      expect(mock.lastForceCommits).toHaveLength(1);
      expect(mock.lastForceCommits![0].root_hash).toBe(root);
      // 本地链推后全盖戳
      expect(chainOf(dir, 'solo').commits[0].pushedAt).toBeDefined();
    } finally {
      mock.mainChain = [];
    }
  });
});

describe('branch / switch / merge（本地链）', () => {
  async function practiceWithCommit(dir: string): Promise<string> {
    await pop(dir, ['practice', 'new', 'my-practice']);
    const root = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root, '--to', 'my-practice', '--keep']);
    return root;
  }

  it('branch 列表 * 标当前支；建支/删支走本地链', async () => {
    const dir = await hubWorkspace();
    const root = await practiceWithCommit(dir);
    const list = await pop(dir, ['branch']);
    expect(list.stdout).toMatch(/^\* main/m);

    const create = await pop(dir, ['branch', 'feat']);
    expect(create.code).toBe(0);
    expect(create.stdout).toMatch(/created branch: feat/);
    expect(chainOf(dir, 'my-practice').branches.feat).toBe(root);

    const del = await pop(dir, ['branch', '-d', 'feat']);
    expect(del.code).toBe(0);
    expect(chainOf(dir, 'my-practice').branches.feat).toBeUndefined();
  });

  it('switch 切当前支（写 chain.json）；不存在的支报错', async () => {
    const dir = await hubWorkspace();
    await practiceWithCommit(dir);
    await pop(dir, ['branch', 'feat']);
    const sw = await pop(dir, ['switch', 'feat']);
    expect(sw.code).toBe(0);
    expect(chainOf(dir, 'my-practice').current).toBe('feat');

    const bad = await pop(dir, ['switch', 'nope']);
    expect(bad.code).toBe(1);
    expect(chainOf(dir, 'my-practice').current).toBe('feat');
  });

  it('merge：FF 纯移指针零新提交；同树分叉=指针移动', async () => {
    const dir = await hubWorkspace();
    const root = await practiceWithCommit(dir);
    mock.createdBranches = []; // 本测试要断言「推本地新支时对 hub 自动建支」
    await pop(dir, ['branch', 'feat']);
    // feat 支上发布一篇新 pop
    const root2 = (await pop(dir, ['new', '--json', JSON.stringify(DOC2)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['switch', 'feat']);
    const pub = await pop(dir, ['publish', root2, '--keep']);
    expect(pub.code).toBe(0);
    expect(chainOf(dir, 'my-practice').branches.feat).toBe(root2);

    // main ← feat：feat 头的 parent=root(main 头) → FF 纯移指针
    const before = chainOf(dir, 'my-practice').commits.length;
    const ff = await pop(dir, ['switch', 'main']);
    expect(ff.code).toBe(0);
    const merged = await pop(dir, ['merge', 'feat']);
    expect(merged.code).toBe(0);
    expect(merged.stdout).toMatch(/fast-forward: main →/);
    expect(chainOf(dir, 'my-practice').branches.main).toBe(root2);
    expect(chainOf(dir, 'my-practice').commits.length).toBe(before); // FF 零新提交

    // 分叉合并：两支各有独立提交 → 指针移动（同树提交即同一提交，无法带第二 parent）
    await pop(dir, ['branch', 'topic', '--from', root]);
    const root3 = (await pop(dir, ['new', '--json', JSON.stringify({ name: 'Topic pop', content: 'topic body' })])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['switch', 'topic']);
    await pop(dir, ['publish', root3, '--keep']);
    await pop(dir, ['switch', 'main']);
    const diverged = await pop(dir, ['merge', 'topic']);
    expect(diverged.code).toBe(0);
    expect(diverged.stdout).toMatch(/pointer move/);
    expect(chainOf(dir, 'my-practice').branches.main).toBe(root3);
    // 两支都是本地诞生、首推时对 hub 自动建支（视图 404 → POST branches → 重取）
    expect(mock.createdBranches).toEqual(['feat', 'topic']);
  });
});

describe('history：本地链重写', () => {
  async function practiceWithTwoCommits(dir: string): Promise<{ root1: string; root2: string }> {
    await pop(dir, ['practice', 'new', 'my-practice']);
    const root1 = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root1, '--to', 'my-practice', '--keep']);
    const root2 = (await pop(dir, ['new', '--json', JSON.stringify(DOC2)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root2, '--to', 'my-practice', '--keep']);
    return { root1, root2 };
  }

  it('reword 改中间条说明（root 不变）；重写后 push 分叉须 --force', async () => {
    const dir = await hubWorkspace();
    const { root1 } = await practiceWithTwoCommits(dir);
    const out = await pop(dir, ['history', 'reword', '1', '-m', '初版：修正说明']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/reworded: v1/);
    const chain = chainOf(dir, 'my-practice');
    expect(chain.commits[0].message).toBe('初版：修正说明');
    expect(chain.commits[0].root).toBe(root1);
    expect(chain.commits[0].pushedAt).toBeUndefined(); // 重写清戳

    mock.mainChain = [
      { seq: 2, root_hash: chain.commits[1].root, parent_hash: root1 },
      { seq: 1, root_hash: root1, parent_hash: null },
    ];
    try {
      const rejected = await pop(dir, ['push', '--practice', 'my-practice']);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toMatch(/push --force/);
    } finally {
      mock.mainChain = [];
    }
  });

  it('squash 合并相邻两条（内容取后者，说明拼接，seq 重排）', async () => {
    const dir = await hubWorkspace();
    const { root1, root2 } = await practiceWithTwoCommits(dir);
    const out = await pop(dir, ['history', 'squash', '1']);
    expect(out.code).toBe(0);
    const chain = chainOf(dir, 'my-practice');
    expect(chain.commits).toHaveLength(1);
    expect(chain.commits[0].seq).toBe(1);
    expect(chain.commits[0].root).toBe(root2);
    expect(chain.commits[0].message).toContain('Hub bridge doc');
    expect(chain.commits[0].message).toContain('Second pop');
    expect(chain.commits[0].parent).toBeNull();
    expect(chain.branches.main).toBe(root2);
    void root1;
  });

  it('reset 回退支头：其后提交丢弃', async () => {
    const dir = await hubWorkspace();
    await practiceWithTwoCommits(dir);
    const out = await pop(dir, ['history', 'reset', '1']);
    expect(out.code).toBe(0);
    const chain = chainOf(dir, 'my-practice');
    expect(chain.commits).toHaveLength(1);
    expect(chain.branches.main).toBe(chain.commits[0].root);
  });

  it('reset 丢弃的提交被其它支指着 → 悬空指针沿重写前 parent 链落到存活祖先（不是空支）', async () => {
    const dir = await hubWorkspace();
    const { root1 } = await practiceWithTwoCommits(dir);
    await pop(dir, ['branch', 'feat']); // feat = main 头 = v2
    await pop(dir, ['history', 'reset', '1']); // main 回 v1，v2 丢弃——feat 悬空
    const chain = chainOf(dir, 'my-practice');
    expect(chain.branches.main).toBe(root1);
    expect(chain.branches.feat).toBe(root1); // v2 的重写前 parent = v1（存活）
  });
});

describe('log / clone / pull / fetch', () => {
  it('log 列本地链（tip 在前）；--json 出结构', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'my-practice']);
    const root1 = (await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root1, '--to', 'my-practice', '--keep']);
    const root2 = (await pop(dir, ['new', '--json', JSON.stringify(DOC2)])).stdout.match(/sha256:[0-9a-f]{64}/)?.[0]!;
    await pop(dir, ['publish', root2, '--to', 'my-practice', '--keep']);

    const out = await pop(dir, ['log', '--practice', 'my-practice']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`v2\\s+${root2.slice(7, 19)}`));
    expect(out.stdout).toMatch(new RegExp(`v1\\s+${root1.slice(7, 19)}`));

    const j = await pop(dir, ['log', '--practice', 'my-practice', '--json']);
    const parsed = JSON.parse(j.stdout) as { branch: string; revisions: { seq: number }[] };
    expect(parsed.branch).toBe('main');
    expect(parsed.revisions).toHaveLength(2);
  });

  it('clone 全链落本地实例仓库（chain.json 同构，不再写 direct 绑定）', async () => {
    const dir = await hubWorkspace();
    const root1 = parseDocument(DOC).rootHash;
    mock.remoteDocs.set(root1, DOC);
    mock.mainChain = [{ seq: 1, root_hash: root1, parent_hash: null }];
    try {
      const out = await pop(dir, ['clone', 'tester/my-practice']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/cloned:  tester\/my-practice \(PRIVATE, branch main, 1 revision/);
      const chain = chainOf(dir, 'my-practice');
      expect(chain.owner).toBe('tester');
      expect(chain.commits).toHaveLength(1);
      expect(chain.commits[0].root).toBe(root1);
      expect(chain.commits[0].pushedAt).toBeDefined();
      expect(chain.branches.main).toBe(root1);
      expect(fs.existsSync(path.join(dir, 'nodes', root1.slice('sha256:'.length) + '.md'))).toBe(true);
    } finally {
      mock.mainChain = [];
      mock.remoteDocs.delete(root1);
    }
  });

  it('pull：hub 前进 → 补对象补链 + 支指针快进；未推分叉报错', async () => {
    const dir = await hubWorkspace();
    const root1 = parseDocument(DOC).rootHash;
    const CHAIN_V2 = { name: 'Second pop', content: 'v2 body' };
    const root2 = parseDocument(CHAIN_V2).rootHash;
    mock.remoteDocs.set(root1, DOC);
    mock.mainChain = [{ seq: 1, root_hash: root1, parent_hash: null }];
    await pop(dir, ['clone', 'tester/my-practice']);

    // hub 前进到 v2（parent=v1）
    mock.remoteDocs.set(root2, CHAIN_V2);
    mock.mainChain = [
      { seq: 2, root_hash: root2, parent_hash: root1 },
      { seq: 1, root_hash: root1, parent_hash: null },
    ];
    try {
      const out = await pop(dir, ['pull']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      const chain = chainOf(dir, 'my-practice');
      expect(chain.commits).toHaveLength(2);
      expect(chain.branches.main).toBe(root2);
      expect(chain.commits[1].pushedAt).toBeDefined();

      // 再拉：up to date
      const again = await pop(dir, ['pull']);
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(/up to date/);
    } finally {
      mock.mainChain = [];
      mock.remoteDocs.delete(root1);
      mock.remoteDocs.delete(root2);
    }
  });

  it('pull 本地新实例（未推）→ 指引先 push；fetch 单拉修订入 pops 区照旧', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['practice', 'new', 'fresh']);
    const never = await pop(dir, ['pull', '--practice', 'fresh']);
    expect(never.code).toBe(1);
    expect(never.stderr).toMatch(/never been pushed/);

    const root = parseDocument(DOC).rootHash;
    mock.remoteDocs.set(root, DOC); // 前面用例的 finally 可能删过 DOC，自给自足
    try {
      const out = await pop(dir, ['fetch', 'tester/my-practice', root]);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(new RegExp(`fetched: ${root}`));
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
      expect(st.direct).toContain(root);
    } finally {
      mock.remoteDocs.delete(root);
    }
  });
});
