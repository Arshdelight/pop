import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { createdRoot, freePort, init, pop, readState, tempDataDir } from './helpers.js';

/**
 * hub 桥集成测试（login 除外）：本地 mock hub 打桩全部端点，凭据直写 practi.auth.json
 * （OAuth 授权页要真浏览器，不进 CI）。覆盖 instance create/bind、branch/switch、
 * push 存文档+绑支头（含 E_NOT_FAST_FORWARD）、merge 快进与 squash 双路径、log、
 * clone/pull（实例同步）/fetch（单拉 POP）。
 */

const DOC = { name: 'Hub bridge doc', content: 'Content that travels to the hub.' };
const ME = { username: 'tester' };

interface MockState {
  /** PUT branches/:b/head 与 POST revisions 对该 hash 返回 422（模拟分叉），其余放行 */
  rejectBindFor: string | null;
  /** mock 里 feat 支的头（测试可改写，squash 场景指到本地工作区的真文档） */
  featHead: string;
  /** feat 头提交的 parent_hash（FF 场景=MAIN_HEAD；squash 场景置 null=分叉） */
  featParent: string | null;
  /** 最近一次 POST revisions 的提交说明（--message 透传断言用） */
  lastMessage: string | null;
  /** /api/v1/pop/:ref 的文档体服务表（root_hash → 创作文档；默认只装 DOC） */
  remoteDocs: Map<string, unknown>;
  /** main 支链覆盖（null=默认硬编码两条；[0] 视为 tip）——clone/pull 用例的远端演进 */
  mainChain: { seq: number; root_hash: string; parent_hash: string | null }[] | null;
  /** revisions 端点对该 hash 回 already_head=true（up-to-date 用例） */
  upToDateFor: string | null;
  storeCalls: number;
  seqCounter: number;
  seenHashes: Set<string>;
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
  mock = {
    rejectBindFor: null,
    featHead: 'sha256:' + 'f'.repeat(64),
    featParent: MAIN_HEAD,
    lastMessage: null,
    remoteDocs: new Map([[parseDocument(DOC).rootHash, DOC]]),
    mainChain: null,
    upToDateFor: null,
    storeCalls: 0, seqCounter: 0, seenHashes: new Set(), bindCalls: [], createdBranches: [], deletedBranches: [],
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
      respond(res, 201, { id: 'inst-1', name: body.name, visibility: body.visibility ?? 'PRIVATE' });
      return;
    }
    // 实例范围修订读取（2026-10-19 内容访问收进仓库上下文；全局 /api/v1/pop/:ref 已退役）
    const revMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)\/revisions\/([^/]+)$/.exec(p);
    if (revMatch && req.method === 'GET') {
      // 文档体服务表（ref 是 URL 编码的）：内容寻址验算过闸的前提是回真身
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
      // 分组：1=owner 2=name 3=branches 段 4=（含斜杠的支名） 5=支名 6=/head|/revisions——解构跳过 4
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
        // main 支链可被测试覆盖（clone/pull 的远端演进）；默认=硬编码两条（log/merge 用例依赖其名字与日期）
        const defaultChain = [
          { seq: 2, root_hash: mock.featHead, parent_hash: mock.featParent, message: 'second edit', created_at: '2026-10-18T00:00:00Z', name: 'second' },
          { seq: 1, root_hash: MAIN_HEAD, parent_hash: null, message: null, created_at: '2026-10-17T00:00:00Z', name: 'first' },
        ];
        const chain = mock.mainChain
          ? mock.mainChain.map((c) => ({ ...c, message: `v${c.seq}`, created_at: '2026-10-19T00:00:00Z', name: `v${c.seq}` }))
          : defaultChain;
        const head = mock.mainChain ? (chain[0]?.root_hash ?? null) : (wanted === 'feat' ? mock.featHead : MAIN_HEAD);
        respond(res, 200, {
          name,
          visibility: 'PRIVATE',
          owner: { account: owner },
          branch: wanted,
          branch_head_hash: head,
          branches: [
            { name: 'main', head_hash: head, is_default: true },
            { name: 'feat', head_hash: mock.featHead, is_default: false },
          ],
          revisions: chain.map((c) => ({ ...c, status: 'PRIVATE', missing: false })),
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
      if (branchName && branchSeg === `/branches/${branchName}/revisions` && req.method === 'POST') {
        // 存+绑合一端点（POP 2.0）：父=当前支头由服务端落库，push 无 FF 拒绝；
        // message 是提交说明（--message / 本地提交日志），记账后回执
        const body = JSON.parse(await readBody(req)) as { document: unknown; message?: string };
        const root = parseDocument(body.document).rootHash;
        mock.storeCalls++;
        mock.lastMessage = body.message ?? null;
        mock.bindCalls.push({ branch: decodeURIComponent(branchName), root_hash: root });
        const idempotent = mock.seenHashes.has(root);
        mock.seenHashes.add(root);
        mock.seqCounter += 1;
        const already = mock.upToDateFor !== null && root === mock.upToDateFor;
        respond(res, already || idempotent ? 200 : 201, {
          root_hash: root,
          status: 'PRIVATE',
          idempotent,
          branch: decodeURIComponent(branchName),
          seq: mock.seqCounter,
          already_head: already,
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
      scope: 'practice:read practice:write practice:delete',
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
  it('push=存+绑单一调用（单 direct 免参猜头）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);

    const out = await pop(dir, ['push']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`pushed:  ${root}`));
    expect(out.stdout).toMatch(new RegExp(`bound:   tester/my-practice@main → ${root}  \\(v\\d+\\)`));
    expect(mock.bindCalls.at(-1)).toEqual({ branch: 'main', root_hash: root });
  });

  it('push --branch 覆盖绑定支；--message 上送提交说明（本地提交日志缺省取用）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);

    const out = await pop(dir, ['push', root, '--branch', 'feat', '--message', 'first drop']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/pushed:/);
    expect(mock.lastMessage).toBe('first drop');
    expect(mock.bindCalls.at(-1)).toEqual({ branch: 'feat', root_hash: root });
  });

  it('多 direct 免参=拒绝并要求显式 hash（一次 push=一个支头）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify({ name: 'Second', content: 'another doc' })])).stdout);
    const before = mock.storeCalls;

    const out = await pop(dir, ['push']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/pass <hash>/);
    expect(mock.storeCalls).toBe(before); // 不许在无法绑定时偷偷落库
  });

  it('重推当前支头=up to date 幂等', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);

    mock.upToDateFor = root;
    try {
      const out = await pop(dir, ['push', root]);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(new RegExp(`up to date — ${root.slice(7, 19)} is already the head of main`));
      expect(out.stdout).not.toMatch(/pushed:/);
    } finally {
      mock.upToDateFor = null;
    }
  });

  it('未绑实例=拒绝推送（pop 在 hub 只以实践实例存放，不做任何存储调用）', async () => {
    const dir = await hubWorkspace();
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    const before = mock.storeCalls;
    const out = await pop(dir, ['push']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/no instance bound/);
    expect(out.stderr).toMatch(/instance create/);
    expect(mock.storeCalls).toBe(before); // 一篇都不许落
  });
});

describe('practi hub bridge: merge', () => {
  it('快进合并：feat tip 沿 parent 链可达 main 头 → 纯移指针零新提交', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    // mock 默认 feat 头=sha256:ff..，其 parent_hash=MAIN_HEAD（GET revisions 带出）→ 客户端判 FF
    const storesBefore = mock.storeCalls;
    const out = await pop(dir, ['merge', 'feat']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/fast-forward: main → f{12}/);
    expect(out.stdout).toMatch(/\(merged feat\)/);
    expect(mock.storeCalls).toBe(storesBefore); // FF 零新提交
  });

  it('分叉合并：parent 链不可达 → squash（POST 文档+message，内容哈希不变）并提示 fetch 同步', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(DOC)])).stdout);
    // feat 头指到本地工作区的真文档（squash 需要本地拿得到 tip 树），parent 置空=分叉
    mock.featHead = root;
    mock.featParent = null;
    try {
      const out = await pop(dir, ['merge', 'feat']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(new RegExp(`merged \\(squash\\): feat → main as ${root.slice(7, 19)}`));
      expect(out.stdout).toMatch(new RegExp(`practi fetch tester/my-practice ${root.slice(7, 19)}`));
      // POP 2.0：squash 不再改写文档内容——同一棵树，提交说明走 message
      expect(mock.lastMessage).toBe("merge branch 'feat'");
      const lastBind = mock.bindCalls.at(-1);
      expect(lastBind?.branch).toBe('main');
      expect(lastBind?.root_hash).toBe(root);
    } finally {
      mock.featHead = 'sha256:' + 'f'.repeat(64);
      mock.featParent = MAIN_HEAD;
    }
  });
});

describe('practi hub bridge: log', () => {
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
});

describe('practi hub bridge: clone / pull / fetch', () => {
  const CHAIN_V1 = { name: 'Chain doc', content: 'v1 body' };
  const CHAIN_V2 = { name: 'Chain doc', content: 'v2 body with more' };
  const rootV1 = parseDocument(CHAIN_V1).rootHash;
  const rootV2 = parseDocument(CHAIN_V2).rootHash;

  it('clone 拉实例+绑定+检出头为 direct（git clone：对象就是实例）', async () => {
    const dir = await hubWorkspace();
    mock.remoteDocs.set(rootV1, CHAIN_V1);
    mock.mainChain = [{ seq: 1, root_hash: rootV1, parent_hash: null }];
    try {
      const out = await pop(dir, ['clone', 'tester/my-practice']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/cloned:  tester\/my-practice \(PRIVATE, branch main, 1 revision/);
      expect(readState(dir).instance).toEqual({ owner: 'tester', name: 'my-practice', branch: 'main' });
      expect(readState(dir).direct).toEqual([rootV1]);
      expect(fs.existsSync(path.join(dir, 'nodes', rootV1.slice('sha256:'.length) + '.md'))).toBe(true);
    } finally {
      mock.mainChain = null;
      mock.remoteDocs.delete(rootV1);
    }
  });

  it('clone 坏 ref 报 usage；clone @branch 段进绑定', async () => {
    const dir = await hubWorkspace();
    const bad = await pop(dir, ['clone', 'not-a-ref']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/usage: practi clone/);

    mock.remoteDocs.set(rootV1, CHAIN_V1);
    mock.mainChain = [{ seq: 1, root_hash: rootV1, parent_hash: null }];
    try {
      const out = await pop(dir, ['clone', 'tester/my-practice@feat']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/branch feat/);
      expect(readState(dir).instance).toEqual({ owner: 'tester', name: 'my-practice', branch: 'feat' });
    } finally {
      mock.mainChain = null;
      mock.remoteDocs.delete(rootV1);
    }
  });

  it('pull：检出远端头 → 远端前进 → fast-forward 换根（git pull 语义）', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    mock.remoteDocs.set(rootV1, CHAIN_V1);
    mock.mainChain = [{ seq: 1, root_hash: rootV1, parent_hash: null }];
    const first = await pop(dir, ['pull']);
    expect(first.code, `stdout=${first.stdout} stderr=${first.stderr}`).toBe(0);
    expect(readState(dir).direct).toEqual([rootV1]);

    // 远端前进到 v2（parent=v1）：本地头在链上 → fast-forward
    mock.remoteDocs.set(rootV2, CHAIN_V2);
    mock.mainChain = [
      { seq: 2, root_hash: rootV2, parent_hash: rootV1 },
      { seq: 1, root_hash: rootV1, parent_hash: null },
    ];
    try {
      const out = await pop(dir, ['pull']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/pulled:  1 revision/);
      expect(out.stdout).toMatch(/fast-forwarded/);
      expect(readState(dir).direct).toEqual([rootV2]);
      expect(fs.existsSync(path.join(dir, 'nodes', rootV2.slice('sha256:'.length) + '.md'))).toBe(true);

      // 再拉一次：up to date
      const again = await pop(dir, ['pull']);
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(/up to date/);
    } finally {
      mock.mainChain = null;
      mock.remoteDocs.delete(rootV1);
      mock.remoteDocs.delete(rootV2);
    }
  });

  it('pull 未绑实例 → 指引 clone/bind；带 hash → 指引 fetch', async () => {
    const dir = await hubWorkspace();
    const noBind = await pop(dir, ['pull']);
    expect(noBind.code).toBe(1);
    expect(noBind.stderr).toMatch(/no instance bound/);
    expect(noBind.stderr).toMatch(/practi clone/);

    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    const withHash = await pop(dir, ['pull', rootV1]);
    expect(withHash.code).toBe(1);
    expect(withHash.stderr).toMatch(/practi fetch/);
  });

  it('pull：本地头不在链上（未推送的本地改动）→ 检出远端头、本地改动保留', async () => {
    const dir = await hubWorkspace();
    await pop(dir, ['instance', 'bind', 'tester/my-practice']);
    // 本地先造一个未推送的 direct（远端链不含它）
    const localRoot = createdRoot((await pop(dir, ['new', '--json', JSON.stringify({ name: 'Local edit', content: 'not pushed' })])).stdout);
    mock.remoteDocs.set(rootV1, CHAIN_V1);
    mock.mainChain = [{ seq: 1, root_hash: rootV1, parent_hash: null }];
    try {
      const out = await pop(dir, ['pull']);
      expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
      expect(out.stdout).toMatch(/checked out/);
      const st = readState(dir);
      expect(st.direct).toContain(localRoot); // 本地改动保留
      expect(st.direct).toContain(rootV1); // 远端头检出为 direct
    } finally {
      mock.mainChain = null;
      mock.remoteDocs.delete(rootV1);
    }
  });

  it('fetch 带仓库上下文单拉修订入库为 direct（内容寻址验算过闸）；未知 hash/缺仓库段报错', async () => {
    const dir = await hubWorkspace();
    const root = parseDocument(DOC).rootHash; // DOC 默认在服务表里
    const usage = await pop(dir, ['fetch', root]);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/usage: practi fetch <owner>\/<name> <hash>/);

    const out = await pop(dir, ['fetch', 'tester/my-practice', root]);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`fetched: ${root}`));
    expect(readState(dir).direct).toContain(root);
    expect(fs.existsSync(path.join(dir, 'nodes', root.slice('sha256:'.length) + '.md'))).toBe(true);

    const bad = await pop(dir, ['fetch', 'tester/my-practice', 'sha256:' + '9'.repeat(64)]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/fetch failed/);
  });
});
