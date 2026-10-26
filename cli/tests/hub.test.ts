import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { freePort, init, pop, runIn, tempDataDir, chainOf, workingFile, poolFile, writeDoc } from './helpers.js';

/**
 * 实例文件夹 + hub 桥集成测试（文件夹模型，2026-10-20）：本地 mock hub 打桩端点，
 * 凭据直写配置家。覆盖 new（--base 诞生）、commit（含 --amend/门禁回滚）、export、
 * push（首推创建/缺支自动创建/FF/up-to-date/分叉报错/--force）、pull、clone、
 * branch/switch（dirty 守卫）、merge、history（reword/squash/drop/reset）、log、web。
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
  remoteDocs: Map<string, unknown>;
  storeCalls: number;
  forceCalls: number;
  createdInstances: { name: string; visibility?: string }[];
  /** CLI 对远端缺失的支自动建支的记录（真实 hub：显式未知支名视图 404，建支后重取） */
  createdBranches: string[];
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

/** mock hub + 已登录凭据的配置家 */
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

/** 带一篇首版修订的实例文件夹（new --base） */
async function practiceWithCommit(home: string, parent = tempDataDir()): Promise<{ repo: string; root: string }> {
  const file = writeDoc(parent, 'seed-doc.json', DOC);
  const created = await runIn(parent, home, ['new', 'my-practice', '--base', file]);
  if (created.code !== 0) throw new Error(`new failed: ${created.stdout}\n${created.stderr}`);
  const repo = path.join(parent, 'my-practice');
  return { repo, root: chainOf(repo).commits[0]!.root };
}

describe('new：实例文件夹诞生', () => {
  it('new --base：工作文件+链 v1+.practi 池；目录已存在拒绝', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const file = writeDoc(parent, 'doc.json', DOC);
    const out = await runIn(parent, home, ['new', 'my-practice', '--base', file]);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    const repo = path.join(parent, 'my-practice');
    expect(fs.existsSync(workingFile(repo))).toBe(true);
    const chain = chainOf(repo);
    expect(chain.name).toBe('my-practice');
    expect(chain.owner).toBeNull();
    expect(chain.branches).toEqual({ main: chain.commits[0]!.root });
    expect(chain.commits).toHaveLength(1);
    expect(fs.existsSync(poolFile(repo, chain.commits[0]!.root))).toBe(true);

    const again = await runIn(parent, home, ['new', 'my-practice']);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });

  it('new 空仓库：链空支 null，工作文件不存在时 commit 给指引', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'empty-practice']);
    const repo = path.join(parent, 'empty-practice');
    expect(chainOf(repo).branches).toEqual({ main: null });
    const c = await runIn(repo, home, ['commit', '-m', 'x']);
    expect(c.code).toBe(1);
    expect(c.stderr).toMatch(/working file empty-practice\.json not found/);
  });
});

describe('commit：快照工作文件（本地）', () => {
  it('修订追加：链上 v2、工作文件与头一致时 nothing to commit', async () => {
    const home = await hubHome();
    const { repo, root } = await practiceWithCommit(home);
    const wf = workingFile(repo);
    const edited = JSON.parse(fs.readFileSync(wf, 'utf8')) as { content: string };
    edited.content = 'Changed content for revision two.';
    fs.writeFileSync(wf, JSON.stringify(edited, null, 2) + '\n', 'utf8');

    const out = await runIn(repo, home, ['commit', '-m', 'second revision']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    const chain = chainOf(repo);
    expect(chain.commits).toHaveLength(2);
    expect(chain.commits[1]!.message).toBe('second revision');
    expect(chain.commits[1]!.parent).toBe(root);
    expect(chain.branches.main).toBe(chain.commits[1]!.root);
    expect(chain.owner).toBeNull(); // commit 不碰网络

    const again = await runIn(repo, home, ['commit', '-m', 'noop']);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/nothing to commit/);
    expect(chainOf(repo).commits).toHaveLength(2);
  });

  it('坏 JSON 拒绝；解析不过的 --base 干净拒绝（不留半截文件夹）', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const repo = path.join(parent, 'my-practice');

    const bad = await runIn(parent, home, ['new', 'my-practice', '--base', writeDoc(parent, 'broken.json', { type: 'practice', name: 'x', content: 'y' })]);
    expect(bad.code).toBe(1);
    expect(fs.existsSync(repo)).toBe(false); // practice 类型无 children 解析不过 → 不落盘

    const file = writeDoc(parent, 'doc.json', DOC);
    await runIn(parent, home, ['new', 'my-practice', '--base', file]);
    const wf = workingFile(repo);
    const before = chainOf(repo).commits.length;

    fs.writeFileSync(wf, '{ not json', 'utf8');
    const out = await runIn(repo, home, ['commit', '-m', 'bad']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/E_JSON/);
    expect(chainOf(repo).commits.length).toBe(before);
  });

  it('--amend 替换支头；message-only amend 即改说明', async () => {
    const home = await hubHome();
    const { repo } = await practiceWithCommit(home);
    const wf = workingFile(repo);
    const edited = JSON.parse(fs.readFileSync(wf, 'utf8')) as { content: string };
    edited.content = 'Amended body.';
    fs.writeFileSync(wf, JSON.stringify(edited, null, 2) + '\n', 'utf8');
    const out = await runIn(repo, home, ['commit', '--amend', '-m', 'renamed head']);
    expect(out.code).toBe(0);
    const chain = chainOf(repo);
    expect(chain.commits).toHaveLength(1);
    expect(chain.commits[0]!.message).toBe('renamed head');
    expect(chain.commits[0]!.pushedAt).toBeUndefined();

    const reword = await runIn(repo, home, ['commit', '--amend', '-m', 'reworded only']);
    expect(reword.code).toBe(0);
    expect(chainOf(repo).commits[0]!.message).toBe('reworded only');
  });
});

describe('export：修订 → 文档文件', () => {
  it('头修订 round-trip（stdout 纯 JSON）；-o 落盘', async () => {
    const home = await hubHome();
    const { repo, root } = await practiceWithCommit(home);
    const out = await runIn(repo, home, ['export', root.slice(7, 19)]);
    expect(out.code).toBe(0);
    const doc = JSON.parse(out.stdout) as { name: string };
    expect(doc.name).toBe(DOC.name);
    const target = path.join(repo, 'exported.json');
    const o = await runIn(repo, home, ['export', root.slice(7, 19), '-o', target]);
    expect(o.code).toBe(0);
    expect((JSON.parse(fs.readFileSync(target, 'utf8')) as { name: string }).name).toBe(DOC.name);
  });
});

describe('branch / switch：支指针 + dirty 守卫', () => {
  it('branch 建删列；* 标当前支；switch 回写工作文件，dirty 拒切', async () => {
    const home = await hubHome();
    const { repo, root } = await practiceWithCommit(home);
    await runIn(repo, home, ['branch', 'feat']);
    const list1 = await runIn(repo, home, ['branch']);
    expect(list1.stdout).toMatch(/\* main/);
    expect(list1.stdout).toMatch(/^  feat/m);

    const sw = await runIn(repo, home, ['switch', 'feat']);
    expect(sw.code).toBe(0);
    const list2 = await runIn(repo, home, ['branch']);
    expect(list2.stdout).toMatch(/\* feat/);

    // dirty：改工作文件后拒切，头不变
    const wf = workingFile(repo);
    fs.writeFileSync(wf, JSON.stringify({ ...DOC, content: 'dirty' }, null, 2) + '\n', 'utf8');
    const refused = await runIn(repo, home, ['switch', 'main']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/uncommitted changes/);
    expect(chainOf(repo).current).toBe('feat');

    fs.writeFileSync(wf, JSON.stringify(DOC, null, 2) + '\n', 'utf8');
    const ok = await runIn(repo, home, ['switch', 'main']);
    expect(ok.code).toBe(0);
    expect((JSON.parse(fs.readFileSync(wf, 'utf8')) as { name: string }).name).toBe(DOC.name);
    void root;
  });

  it('不存在的支报错', async () => {
    const home = await hubHome();
    const { repo } = await practiceWithCommit(home);
    const bad = await runIn(repo, home, ['switch', 'nope']);
    expect(bad.code).toBe(1);
    expect(chainOf(repo).current).toBe('main');
  });
});

describe('merge：FF 与指针移动 + dirty 守卫', () => {
  it('FF 纯移指针零新提交；分叉=指针移动；dirty 拒合并', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const { repo } = await practiceWithCommit(home, parent);
    await runIn(repo, home, ['branch', 'feat']);
    await runIn(repo, home, ['switch', 'feat']);
    // feat 支上提交一版
    const wf = workingFile(repo);
    fs.writeFileSync(wf, JSON.stringify(DOC2, null, 2) + '\n', 'utf8');
    const c = await runIn(repo, home, ['commit', '-m', 'feat revision']);
    expect(c.code, `stdout=${c.stdout} stderr=${c.stderr}`).toBe(0);
    const featHead = chainOf(repo).branches.feat!;

    const ff = await runIn(repo, home, ['switch', 'main']).then(() => runIn(repo, home, ['merge', 'feat']));
    expect(ff.code).toBe(0);
    expect(ff.stdout).toMatch(/fast-forward: main/);
    const chain = chainOf(repo);
    expect(chain.branches.main).toBe(featHead);
    expect(chain.commits).toHaveLength(2); // FF 零新提交
    expect((JSON.parse(fs.readFileSync(wf, 'utf8')) as { name: string }).name).toBe(DOC2.name); // 工作文件跟头

    // 分叉：topic 从 v1 建支，独立提交 → main 合并 = 指针移动
    await runIn(repo, home, ['branch', 'topic', '--from', chain.commits[0]!.root]);
    await runIn(repo, home, ['switch', 'topic']);
    fs.writeFileSync(wf, JSON.stringify({ name: 'Topic pop', content: 'topic body' }, null, 2) + '\n', 'utf8');
    await runIn(repo, home, ['commit', '-m', 'topic revision']);
    await runIn(repo, home, ['switch', 'main']);
    const diverged = await runIn(repo, home, ['merge', 'topic']);
    expect(diverged.code).toBe(0);
    expect(diverged.stdout).toMatch(/pointer move/);
    expect(chainOf(repo).branches.main).toBe(chainOf(repo).branches.topic);

    // dirty 拒合并
    fs.writeFileSync(wf, JSON.stringify({ ...DOC, content: 'dirty merge' }, null, 2) + '\n', 'utf8');
    const refused = await runIn(repo, home, ['merge', 'feat']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/uncommitted changes/);
  });
});

describe('push：首推创建/缺支自动创建/FF/分叉/--force', () => {
  it('首推在 hub 诞生实例（回填 owner）；FF 逐条；再推 up to date', async () => {
    const home = await hubHome();
    const { repo, root } = await practiceWithCommit(home);
    const out = await runIn(repo, home, ['push']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`created on the hub: ${ME.username}/my-practice`));
    expect(mock.createdInstances).toEqual([{ name: 'my-practice', visibility: 'PRIVATE' }]);
    expect(mock.storeCalls).toBe(1);
    expect(chainOf(repo).owner).toBe(ME.username);
    expect(chainOf(repo).commits[0]!.pushedAt).toBeDefined();

    mock.mainChain = [{ seq: 1, root_hash: root, parent_hash: null }]; // hub 视角已有这条链
    const again = await runIn(repo, home, ['push']);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/up to date/);
    expect(mock.storeCalls).toBe(1);
    mock.mainChain = [];
  });

  it('本地新建的支首推时对 hub 自动建支（视图 404 → POST branches → 重取）', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const { repo } = await practiceWithCommit(home, parent);
    await runIn(repo, home, ['push']);
    mock.createdBranches = [];
    await runIn(repo, home, ['branch', 'feat']);
    await runIn(repo, home, ['switch', 'feat']);
    const wf = workingFile(repo);
    fs.writeFileSync(wf, JSON.stringify(DOC2, null, 2) + '\n', 'utf8');
    await runIn(repo, home, ['commit', '-m', 'feat revision']);
    const out = await runIn(repo, home, ['push']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/branch created on the hub: feat/);
    expect(mock.createdBranches).toEqual(['feat']);
  });

  it('分叉报错；--force 全链覆盖（hub dropped 回执透传）', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const { repo, root } = await practiceWithCommit(home, parent);
    await runIn(repo, home, ['push']);
    mock.mainChain = [{ seq: 1, root_hash: root, parent_hash: null }];
    // 本地重写：amend 换内容（root 变）→ 与 hub 真分叉（hub 头不在本地链）
    fs.writeFileSync(workingFile(repo), JSON.stringify({ ...DOC, content: 'rewritten body' }, null, 2) + '\n', 'utf8');
    await runIn(repo, home, ['commit', '--amend', '-m', 'rewritten locally']);
    const rewritten = chainOf(repo).commits[0]!.root;
    expect(rewritten).not.toBe(root);
    const rejected = await runIn(repo, home, ['push']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toMatch(/push --force/);

    mock.forceDropped = 1;
    const forced = await runIn(repo, home, ['push', '--force']);
    expect(forced.code, `stdout=${forced.stdout} stderr=${forced.stderr}`).toBe(0);
    expect(forced.stdout).toMatch(/forced:\s+1 revision\(s\)/);
    expect(forced.stdout).toMatch(/hub dropped 1 unreachable/);
    expect(mock.lastForceCommits).toEqual([
      { seq: 1, root_hash: rewritten, parent_hash: null, message: 'rewritten locally' },
    ]);
    expect(chainOf(repo).commits[0]!.pushedAt).toBeDefined();
    mock.mainChain = [];
    mock.forceDropped = 0;
  });
});

describe('pull：对账 + dirty 守卫', () => {
  it('hub 前进 → 补对象补链+FF+工作文件回写；未推实例拒拉', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const root1 = parseDocument(DOC).rootHash;
    const root2 = parseDocument(DOC2).rootHash;
    mock.remoteDocs.set(root1, DOC);
    mock.mainChain = [{ seq: 1, root_hash: root1, parent_hash: null }];
    const cloned = await runIn(parent, home, ['clone', 'tester/my-practice']);
    expect(cloned.code, `stdout=${cloned.stdout} stderr=${cloned.stderr}`).toBe(0);
    const repo = path.join(parent, 'my-practice');

    mock.remoteDocs.set(root2, DOC2);
    mock.mainChain = [
      { seq: 2, root_hash: root2, parent_hash: root1 },
      { seq: 1, root_hash: root1, parent_hash: null },
    ];
    try {
      const out = await runIn(repo, home, ['pull']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      const chain = chainOf(repo);
      expect(chain.commits).toHaveLength(2);
      expect(chain.branches.main).toBe(root2);
      expect((JSON.parse(fs.readFileSync(workingFile(repo), 'utf8')) as { name: string }).name).toBe(DOC2.name);

      const again = await runIn(repo, home, ['pull']);
      expect(again.stdout).toMatch(/up to date/);

      // dirty 拒拉
      fs.writeFileSync(workingFile(repo), JSON.stringify({ ...DOC, content: 'dirty' }, null, 2) + '\n', 'utf8');
      const refused = await runIn(repo, home, ['pull']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/uncommitted changes/);
    } finally {
      mock.mainChain = [];
      mock.remoteDocs.delete(root1);
      mock.remoteDocs.delete(root2);
    }
  });

  it('本地新实例（未推）拒拉', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'fresh']);
    const never = await runIn(path.join(parent, 'fresh'), home, ['pull']);
    expect(never.code).toBe(1);
    expect(never.stderr).toMatch(/never been pushed/);
  });
});

describe('clone：全链落实例文件夹', () => {
  it('工作文件+链同构+池对象齐', async () => {
    const home = await hubHome();
    const parent = tempDataDir();
    const root1 = parseDocument(DOC).rootHash;
    mock.remoteDocs.set(root1, DOC);
    mock.mainChain = [{ seq: 1, root_hash: root1, parent_hash: null }];
    try {
      const out = await runIn(parent, home, ['clone', 'tester/my-practice']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      const repo = path.join(parent, 'my-practice');
      const chain = chainOf(repo);
      expect(chain.owner).toBe('tester');
      expect(chain.commits).toHaveLength(1);
      expect(chain.commits[0]!.root).toBe(root1);
      expect(chain.commits[0]!.pushedAt).toBeDefined();
      expect((JSON.parse(fs.readFileSync(workingFile(repo), 'utf8')) as { name: string }).name).toBe(DOC.name);
      expect(fs.existsSync(poolFile(repo, root1))).toBe(true);
    } finally {
      mock.mainChain = [];
      mock.remoteDocs.delete(root1);
    }
  });
});

/** 带两版修订的实例文件夹（v1=DOC、v2=DOC2） */
async function practiceWithTwoCommits(home: string, parent = tempDataDir()): Promise<{ repo: string; root1: string; root2: string }> {
  const file = writeDoc(parent, 'seed-doc.json', DOC);
  await runIn(parent, home, ['new', 'my-practice', '--base', file]);
  const repo = path.join(parent, 'my-practice');
  const wf = workingFile(repo);
  fs.writeFileSync(wf, JSON.stringify(DOC2, null, 2) + '\n', 'utf8');
  const c = await runIn(repo, home, ['commit', '-m', 'second']);
  if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);
  const chain = chainOf(repo);
  return { repo, root1: chain.commits[0]!.root, root2: chain.commits[1]!.root };
}

describe('history：本地链重写', () => {
  it('reword 改说明（root 不变，清戳）；squash 折叠；drop 删中间条', async () => {
    const home = await hubHome();
    const { repo, root1, root2 } = await practiceWithTwoCommits(home);
    const out = await runIn(repo, home, ['history', 'reword', '1', '-m', '初版：修正说明']);
    expect(out.code).toBe(0);
    const chain = chainOf(repo);
    expect(chain.commits[0]!.message).toBe('初版：修正说明');
    expect(chain.commits[0]!.root).toBe(root1);
    expect(chain.commits[0]!.pushedAt).toBeUndefined();

    const sq = await runIn(repo, home, ['history', 'squash', '1']);
    expect(sq.code).toBe(0);
    const squashed = chainOf(repo);
    expect(squashed.commits).toHaveLength(1);
    expect(squashed.commits[0]!.root).toBe(root2);
    expect(squashed.commits[0]!.message).toContain('初版：修正说明');
    expect(squashed.commits[0]!.message).toContain('second');

    // drop 重建两版再删 v1
    const wf = workingFile(repo);
    fs.writeFileSync(wf, JSON.stringify({ name: 'Third pop', content: 'third' }, null, 2) + '\n', 'utf8');
    await runIn(repo, home, ['commit', '-m', 'third']);
    const dp = await runIn(repo, home, ['history', 'drop', '1']);
    expect(dp.code).toBe(0);
    const dropped = chainOf(repo);
    expect(dropped.commits.map((c) => c.message)).toEqual(['third']);
    expect(dropped.commits[0]!.parent).toBeNull();
  });

  it('reset 回退支头（git reset 语义：工作树不动）；丢弃的提交被其它支指着 → 指针落到存活祖先', async () => {
    const home = await hubHome();
    const { repo, root1 } = await practiceWithTwoCommits(home);
    await runIn(repo, home, ['branch', 'feat']); // feat = main 头 = v2
    const out = await runIn(repo, home, ['history', 'reset', '1']);
    expect(out.code).toBe(0);
    const chain = chainOf(repo);
    expect(chain.commits).toHaveLength(1);
    expect(chain.branches.main).toBe(root1);
    expect(chain.branches.feat).toBe(root1); // v2 的重写前 parent = v1（存活）
    // 工作树不动：文件仍持 v2 内容（相对新头=未提交改动），输出给处置提示
    expect(JSON.parse(fs.readFileSync(workingFile(repo), 'utf8'))).toEqual(DOC2);
    expect(out.stdout).toMatch(/working file still holds the pre-rewrite content/);

    // 未提交改动不阻塞 reset——commit 可把它留在新头上
    const wf = workingFile(repo);
    fs.writeFileSync(wf, JSON.stringify({ name: 'Uncommitted pop', content: 'kept' }, null, 2) + '\n', 'utf8');
    const again = await runIn(repo, home, ['commit', '-m', 'kept on top']);
    expect(again.code).toBe(0);
    expect(chainOf(repo).commits).toHaveLength(2);
  });
});

describe('log：提交历史', () => {
  it('tip 在前；--json 出结构', async () => {
    const home = await hubHome();
    const { repo, root1, root2 } = await practiceWithTwoCommits(home);
    const out = await runIn(repo, home, ['log']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`v2\\s+${root2.slice(7, 19)}`));
    expect(out.stdout).toMatch(new RegExp(`v1\\s+${root1.slice(7, 19)}`));
    const j = await runIn(repo, home, ['log', '--json']);
    const parsed = JSON.parse(j.stdout) as { branch: string; revisions: { seq: number }[] };
    expect(parsed.branch).toBe('main');
    expect(parsed.revisions).toHaveLength(2);
  });
});

describe('web：实例浏览器', () => {
  it('/api/repo 出链与支；/pop/<root>.json 出聚合视图', async () => {
    const { spawnWeb, untilHealthy } = await import('./helpers.js');
    const home = await hubHome();
    const { repo, root } = await practiceWithCommit(home);
    const port = await freePort();
    const child = spawnWeb(repo, home, port);
    try {
      const base = await untilHealthy(port, child);
      const repoRes = await fetch(`${base}/api/repo`);
      const info = (await repoRes.json()) as { name: string; current: string; commits: { root: string }[] };
      expect(info.name).toBe('my-practice');
      expect(info.current).toBe('main');
      expect(info.commits).toHaveLength(1);
      const view = await fetch(`${base}/pop/${encodeURIComponent(root)}.json`);
      expect(view.ok).toBe(true);
      const page = await fetch(base);
      expect(await page.text()).toContain('chain.js');
    } finally {
      child.kill();
    }
  });

  it('home 模式：目录页列出 practices 家目录，/p/<name>/ 前缀路由可达 wizard；--dir 失败仍硬错', async () => {
    const { spawnWeb, untilHealthy } = await import('./helpers.js');
    const home = await hubHome();
    // 两个实践直接诞生在 <home>/practices/ 下：alpha 有修订、beta 空壳
    const homePractices = path.join(home, 'practices');
    fs.mkdirSync(homePractices, { recursive: true });
    const parent = tempDataDir();
    const file = writeDoc(parent, 'seed-doc.json', DOC);
    const mk = await runIn(homePractices, home, ['new', 'alpha', '--base', file]);
    expect(mk.code, mk.stderr).toBe(0);
    await runIn(homePractices, home, ['new', 'beta']);
    const root = chainOf(path.join(homePractices, 'alpha')).commits[0]!.root;

    const port = await freePort();
    const child = spawnWeb(parent, home, port); // cwd 非实例文件夹 → home 模式
    try {
      const base = await untilHealthy(port, child, 15_000, '/api/practices');
      const page = await fetch(base);
      expect(page.ok).toBe(true);
      expect(await page.text()).toContain('home.js');

      const listRes = await fetch(`${base}/api/practices`);
      const list = (await listRes.json()) as { name: string; commits: number; head: { root: string } | null; updated: string | null }[];
      expect(list.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
      const alpha = list.find((p) => p.name === 'alpha')!;
      expect(alpha.commits).toBe(1);
      expect(alpha.head?.root).toBe(root);
      expect(alpha.updated).toBeTruthy();
      const beta = list.find((p) => p.name === 'beta')!;
      expect(beta.commits).toBe(0);
      expect(beta.head).toBeNull();

      // 前缀路由：wizard 数据窗与链数据窗、页面注入前缀变量
      const view = await fetch(`${base}/p/alpha/pop/${encodeURIComponent(root)}.json`);
      expect(view.ok).toBe(true);
      const repoInfo = (await (await fetch(`${base}/p/alpha/api/repo`)).json()) as { name: string };
      expect(repoInfo.name).toBe('alpha');
      const chainPage = await (await fetch(`${base}/p/alpha/`)).text();
      expect(chainPage).toContain('window.POP_WEB_PREFIX="/p/alpha"');
      const wizardPage = await fetch(`${base}/p/alpha/pop/${encodeURIComponent(root)}`);
      expect(await wizardPage.text()).toContain('window.POP_WEB_PREFIX="/p/alpha"');
      // 空壳实例链页可达；未知实例 404；未前缀的实例路由不外溢
      expect((await fetch(`${base}/p/beta/`)).ok).toBe(true);
      expect((await fetch(`${base}/p/missing/`)).status).toBe(404);
      expect((await fetch(`${base}/api/repo`)).status).toBe(404);
    } finally {
      child.kill();
    }

    // 显式 --dir 指向非实例文件夹仍是硬错误（用户点名了文件夹）
    const bad = await runIn(parent, home, ['web', '--dir', parent, '--no-open']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('not a practice folder');
  });
});
