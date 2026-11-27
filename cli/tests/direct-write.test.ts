import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '@arshdelight/pop-sdk';
import { freePort, init, pop, runIn, tempDataDir, writeDoc, sha256 } from './helpers.js';

/**
 * 直写面（带地址直接操作 hub 的写路径，2026-11-27）：
 * - `commit <owner>/<name>[@branch] --file`：追加（默认 / --base）/ --amend（force 端点
 *   替换支头那条）/ --force（整条链换成这一份文档）
 * - `new <name> --file`：hub 上诞生私有实例 + main 落第一版，不建本地文件夹
 * - `blob add <owner>/<name> <file>`：字节直传 hub
 * 本地 mock hub 打桩五个端点（GET 实例视图、POST /instances、POST branches、
 * POST revisions（含 ?force=1 与 parent_hash 检查）、PUT blobs），凭据直写配置家——
 * 与 direct-read.test.ts 同构。全部走 127.0.0.1，不碰真实网络。
 */

const DOC1 = { type: 'action', name: 'Seed revision', content: 'The first revision body.', outputs: [{ name: 'seed done', spec: 'exists' }] };
const DOC2 = { type: 'action', name: 'Head revision', content: 'The second revision body.', outputs: [{ name: 'head done', spec: 'exists' }] };
const DOC3 = { type: 'action', name: 'Direct write', content: 'A brand new revision body.', outputs: [{ name: 'written', spec: 'exists' }] };
/** W_ 级：合法但瘦（无 outputs → W_NO_VERIFY），不拦提交 */
const DOC_W = { type: 'action', name: 'Thin but legal', content: 'Has content but no outputs.' };
/** E_ 级：未知字段（parseDocument 就拒） */
const DOC_E = { type: 'action', name: 'Broken', content: 'Unknown field present.', bogus: 1 };
/** E_ 级：媒体引用悬空（导入能过，validateWorkspace 拦） */
const DOC_MEDIA = { type: 'action', name: 'Dangling media', content: 'See ![pic](pic.png).' };
/** 并发对手：amend 复查时被人先推的版本 */
const DOC_RIVAL = { type: 'action', name: 'Rival revision', content: 'Someone else pushed this first.', outputs: [{ name: 'rival', spec: 'exists' }] };

const BLOB_BYTES = Buffer.from('fake png bytes for the direct-write suite');

const OWNER = 'tester';
const NAME = 'direct-p';
const REF = `${OWNER}/${NAME}`;

const r1 = parseDocument(DOC1).rootHash;
const r2 = parseDocument(DOC2).rootHash;
const r3 = parseDocument(DOC3).rootHash;
const RIVAL_ROOT = parseDocument(DOC_RIVAL).rootHash;

/** 内容寻址哈希（与 helpers.sha256 同式；这里要对 Buffer 常量算，独立一份） */
const FIG_HASH = sha256(BLOB_BYTES);

/** 文档引用的附件 hash（树内递归；与 src/client.ts collectAttachmentHashes 同口径） */
function attachmentHashes(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (node === null || typeof node !== 'object') return out;
  const n = node as { attachments?: { hash?: unknown }[]; children?: unknown[] };
  for (const a of n.attachments ?? []) if (typeof a.hash === 'string' && a.hash !== '') out.add(a.hash);
  for (const c of n.children ?? []) attachmentHashes(c, out);
  return out;
}

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

/* ── mock 状态（每个测试 resetHub 重置） ── */
let instanceExists: boolean;
/** 支名 → 历史（新的在先） */
let branchChains: Map<string, Revision[]>;
let docs: Map<string, unknown>;
let blobs: Map<string, Buffer>;
let createdInstances: { name: string; visibility?: string }[];
let createdBranches: string[];
let revisionPosts: { branch: string; force: boolean; body: Record<string, unknown> }[];
let blobWrites: Map<string, Buffer>;
/** 写请求顺序（instances / branch / revision / blob）——顺序断言用 */
let requestLog: string[];
let blobRejectOnce: string | null;
let failNextRevision: { status: number; body: Record<string, unknown> } | null;
let forceDropped: number;
/** 第 N 次取实例视图时往该支塞一条并发修订（模拟「复查时头已换」） */
let swapHeadOnViewNo: number;
let viewFetches: number;

function revisionOf(seq: number, root: string, parent: string | null, message: string): Revision {
  return { seq, root_hash: root, parent_hash: parent, message, created_at: '2026-11-27T00:00:00.000Z', status: 'PRIVATE' };
}

function resetHub(opts: { instance?: boolean; chain?: { doc: unknown; message: string }[] } = {}): void {
  instanceExists = opts.instance ?? true;
  branchChains = new Map([['main', []]]);
  docs = new Map();
  blobs = new Map();
  createdInstances = [];
  createdBranches = [];
  revisionPosts = [];
  blobWrites = new Map();
  requestLog = [];
  blobRejectOnce = null;
  failNextRevision = null;
  forceDropped = 0;
  swapHeadOnViewNo = 0;
  viewFetches = 0;
  let parent: string | null = null;
  let seq = 1;
  for (const entry of opts.chain ?? []) {
    const root = parseDocument(entry.doc).rootHash;
    docs.set(root, entry.doc);
    branchChains.get('main')!.unshift(revisionOf(seq, root, parent, entry.message));
    parent = root;
    seq += 1;
  }
}

function seedOneRev(): void {
  resetHub({ chain: [{ doc: DOC1, message: 'first revision' }] });
}

function seedTwoRevs(): void {
  resetHub({ chain: [{ doc: DOC1, message: 'first revision' }, { doc: DOC2, message: 'second revision' }] });
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

beforeAll(async () => {
  const port = await freePort();
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

    const blobMatch = /^\/api\/v1\/blobs\/([^/]+)$/.exec(p);
    if (blobMatch && req.method === 'PUT') {
      const hash = decodeURIComponent(blobMatch[1]);
      if (blobRejectOnce !== null) {
        const msg = blobRejectOnce;
        blobRejectOnce = null;
        respond(res, 422, { code: 'E_BLOB_REJECTED', message: msg });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      blobWrites.set(hash, bytes);
      blobs.set(hash, bytes);
      requestLog.push('blob');
      respond(res, 200, { ok: true });
      return;
    }

    if (p === '/api/v1/instances' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name: string; visibility?: string };
      createdInstances.push(body);
      requestLog.push('instances');
      if (instanceExists) {
        respond(res, 409, { code: 'E_DUPLICATE', message: `an instance named "${body.name}" already exists` });
        return;
      }
      instanceExists = true;
      branchChains = new Map([['main', []]]);
      respond(res, 201, { id: 'inst-dw', name: body.name, visibility: body.visibility ?? 'PRIVATE', owner: OWNER });
      return;
    }

    const instMatch = /^\/api\/v1\/instances\/([^/]+)\/([^/]+)(\/branches(\/([^/]+)\/revisions)?)?$/.exec(p);
    if (instMatch) {
      const [, owner, instName, branchSeg, , branchName] = instMatch;
      if (owner !== OWNER) {
        respond(res, 404, { error: 'Instance not found', code: 'E_INSTANCE_NOT_FOUND' });
        return;
      }
      if (!branchSeg) {
        // GET 实例视图（?branch= 指定支；缺省 = 默认支 main）
        if (!instanceExists) {
          respond(res, 404, { error: 'Instance not found', code: 'E_INSTANCE_NOT_FOUND' });
          return;
        }
        const wanted = url.searchParams.get('branch') ?? 'main';
        const chain = branchChains.get(wanted);
        if (chain === undefined) {
          respond(res, 404, { error: `Branch "${wanted}" not found`, code: 'E_BRANCH_NOT_FOUND' });
          return;
        }
        viewFetches += 1;
        if (swapHeadOnViewNo === viewFetches) {
          const head = chain[0]?.root_hash ?? null;
          docs.set(RIVAL_ROOT, DOC_RIVAL);
          chain.unshift(revisionOf((chain[0]?.seq ?? 0) + 1, RIVAL_ROOT, head, 'rival push'));
        }
        respond(res, 200, {
          name: instName,
          description: 'Served straight from the mock hub',
          visibility: 'PRIVATE',
          refines: null,
          owner: { account: OWNER },
          branches: [...branchChains.entries()].map(([b, ch]) => ({
            name: b,
            head_hash: ch[0]?.root_hash ?? null,
            is_default: b === 'main',
          })),
          branch: wanted,
          branch_head_hash: chain[0]?.root_hash ?? null,
          revisions: chain,
        });
        return;
      }
      if (branchSeg === '/branches' && req.method === 'POST') {
        // 从默认支头建支（历史 = 默认支的链）
        const body = JSON.parse(await readBody(req)) as { name: string };
        createdBranches.push(body.name);
        requestLog.push('branch');
        const def = branchChains.get('main') ?? [];
        branchChains.set(body.name, def.map((r) => ({ ...r })));
        respond(res, 201, { name: body.name, head_hash: def[0]?.root_hash ?? null, is_default: false });
        return;
      }
      if (branchName && branchSeg === `/branches/${branchName}/revisions` && req.method === 'POST') {
        const target = decodeURIComponent(branchName);
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        requestLog.push('revision');
        if (url.searchParams.get('force') === '1') {
          revisionPosts.push({ branch: target, force: true, body });
          // 与真 hub 同款的两道校验：每条提交的 parent 必须在链上（或 null）；支指针必须
          // 落在链上。不过就 400，mock 状态不动——这样漏带旧版本的 amend 不会被放水
          const commits = body.commits as { root_hash: string; parent_hash: string | null; message: string | null }[];
          const roots = new Set(commits.map((c) => c.root_hash));
          const broken = commits.find((c) => c.parent_hash !== null && !roots.has(c.parent_hash));
          if (broken) {
            respond(res, 400, { code: 'E_SCHEMA', message: 'the chain is broken (a parent is missing from `commits`)' });
            return;
          }
          const pointers = (body.branches ?? {}) as Record<string, string | null>;
          const dangling = Object.entries(pointers).find(([, r]) => r !== null && !roots.has(r));
          if (dangling) {
            respond(res, 400, { code: 'E_SCHEMA', message: `branch "${dangling[0]}" points at ${dangling[1]}, which is not on the new chain` });
            return;
          }
          // 按 payload 重建：文档入 docs，各支沿 parent 走出 tip 在先的历史（seq 从 1 起）
          for (const d of (body.documents as { root_hash: string; document: unknown }[] | undefined) ?? []) {
            docs.set(d.root_hash, d.document);
          }
          const byRoot = new Map(commits.map((c) => [c.root_hash, c]));
          const historyFrom = (headRoot: string | null): Revision[] => {
            // 从支头沿 parent 走到根，收集顺序是 tip 在先；seq 从根起 1..n
            const path: { root_hash: string; parent_hash: string | null; message: string | null }[] = [];
            for (let cur = headRoot; cur !== null; ) {
              const c = byRoot.get(cur)!;
              path.push(c);
              cur = c.parent_hash;
            }
            return path.map((c, i) => revisionOf(path.length - i, c.root_hash, c.parent_hash, c.message ?? ''));
          };
          const next = new Map<string, Revision[]>();
          for (const [b, headRoot] of Object.entries(pointers)) next.set(b, historyFrom(headRoot));
          // 真 hub：不在 payload 里的支——默认支落到链头，其余删除
          if (!next.has('main')) {
            const parents = new Set(commits.map((c) => c.parent_hash));
            next.set('main', historyFrom(commits.find((c) => !parents.has(c.root_hash))?.root_hash ?? null));
          }
          branchChains = next;
          respond(res, 200, { ok: true, dropped: forceDropped });
          return;
        }
        revisionPosts.push({ branch: target, force: false, body });
        if (failNextRevision) {
          const r = failNextRevision;
          failNextRevision = null;
          respond(res, r.status, r.body);
          return;
        }
        const chain = branchChains.get(target);
        if (chain === undefined) {
          respond(res, 404, { error: `Branch "${target}" not found`, code: 'E_BRANCH_NOT_FOUND' });
          return;
        }
        // parent_hash 检查（真实 hub：给了才查，不符 409 不落版本）
        const head = chain[0]?.root_hash ?? null;
        const given = body.parent_hash;
        if (given !== undefined && given !== head) {
          respond(res, 409, { code: 'E_HEAD_MOVED', message: `parent_hash ${given} is not the current head (${head})` });
          return;
        }
        // 附件字节核对：文档引用而 hub 没有的 → 400 E_BLOB_MISSING（body.missing 列缺失）
        const missing = [...attachmentHashes(body.document)].filter((h) => !blobs.has(h));
        if (missing.length > 0) {
          respond(res, 400, { code: 'E_BLOB_MISSING', message: `${missing.length} attachment byte(s) missing`, missing });
          return;
        }
        const root = parseDocument(body.document).rootHash;
        docs.set(root, body.document);
        const effectiveParent = given !== undefined ? (given as string | null) : head;
        chain.unshift(revisionOf((chain[0]?.seq ?? 0) + 1, root, effectiveParent, typeof body.message === 'string' ? body.message : ''));
        respond(res, 201, { seq: chain[0]!.seq, root_hash: root, already_head: false, idempotent: false });
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

/** mock hub + 已登录凭据的配置家（同 direct-read.test.ts 的 hubHome） */
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

describe('commit 直写 hub：默认追加', () => {
  it('body 含 document 与 message、不含 parent_hash（否定断言）；输出 pushed 行', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'third.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'third revision']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`pushed:\\s+${REF}@main v3\\s+${r3.slice(7, 19)}\\s+third revision`));
    expect(revisionPosts).toHaveLength(1);
    expect(revisionPosts[0]!.force).toBe(false);
    expect(revisionPosts[0]!.body.message).toBe('third revision');
    expect(revisionPosts[0]!.body.document).toEqual(DOC3);
    expect('parent_hash' in revisionPosts[0]!.body).toBe(false);
    expect(requestLog).toEqual(['revision']);
  });

  it('--base v1 → parent_hash 等于 v1 的根', async () => {
    seedOneRev();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'second.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'on top', '--base', 'v1']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(revisionPosts).toHaveLength(1);
    expect(revisionPosts[0]!.body.parent_hash).toBe(r1);
    expect(out.stdout).toMatch(/pushed:\s+tester\/direct-p@main v2/);
  });

  it('--base v99 找不到 → 退出 1，零写请求', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '--base', 'v99']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/no revision v99/);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('--base 与当前支头不符 → 本地拦下，退出 1，零写请求', async () => {
    seedTwoRevs(); // 头是 v2
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '--base', 'v1']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/--base v1/);
    expect(out.stderr).toMatch(/head of tester\/direct-p@main is v2/);
    expect(out.stderr).toMatch(/practi show/);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('文档等于支头 → nothing to commit，零写请求，退出 0', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'head.json', DOC2);
    const out = await pop(home, ['commit', REF, '--file', file]);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`nothing to commit — the document matches ${REF}@main v2 \\(${r2.slice(7, 19)}\\)`));
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('E_ 级文档本地拦下：零请求，退出 1（未知字段 / 悬空媒体引用各一）', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const eFile = writeDoc(tempDataDir(), 'broken.json', DOC_E);
    const e = await pop(home, ['commit', REF, '--file', eFile, '-m', 'x']);
    expect(e.code).toBe(1);
    expect(e.stderr).toMatch(/E_SCHEMA/);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);

    const mFile = writeDoc(tempDataDir(), 'media.json', DOC_MEDIA);
    const m = await pop(home, ['commit', REF, '--file', mFile, '-m', 'x']);
    expect(m.code).toBe(1);
    // createFromDoc 在导入时就拒悬空媒体引用（码是 E_SCHEMA，指名道姓说 media reference）
    expect(m.stderr).toMatch(/E_SCHEMA/);
    expect(m.stderr).toMatch(/media reference/);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('W_ 级提示出现在 stderr 且退出 0', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'thin.json', DOC_W);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'thin']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/pushed:/);
    expect(out.stderr).toMatch(/W_NO_VERIFY/);
    expect(revisionPosts).toHaveLength(1);
  });

  it('--file - 从 stdin 读到 EOF', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const out = await pop(home, ['commit', REF, '--file', '-', '-m', 'via stdin'], { input: JSON.stringify(DOC3) });
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(revisionPosts).toHaveLength(1);
    expect(revisionPosts[0]!.body.document).toEqual(DOC3);
    expect(revisionPosts[0]!.body.message).toBe('via stdin');
  });

  it('409 E_HEAD_MOVED → 退出 1，提示 practi show', async () => {
    seedTwoRevs();
    const home = await hubHome();
    failNextRevision = { status: 409, body: { code: 'E_HEAD_MOVED', message: 'branch head moved' } };
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'x']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/E_HEAD_MOVED/);
    expect(out.stderr).toMatch(/practi show tester\/direct-p@main --doc/);
  });

  it('400 E_BLOB_MISSING → 提示 practi blob add 并列出缺失哈希', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const doc = {
      type: 'action',
      name: 'With attachment',
      content: 'See ![fig](fig.png).',
      attachments: [{ name: 'fig.png', hash: FIG_HASH, mime: 'image/png', size: BLOB_BYTES.length }],
    };
    const file = writeDoc(tempDataDir(), 'blobby.json', doc);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'attach']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/practi blob add tester\/direct-p <file-or-url>/);
    expect(out.stderr).toContain(FIG_HASH);
  });

  it('实例不存在 → 报错并提示 practi new', async () => {
    resetHub({ instance: false });
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'x']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/does not exist on the hub yet/);
    expect(out.stderr).toMatch(/practi new direct-p --file/);
    expect(revisionPosts).toHaveLength(0);
    expect(createdInstances).toHaveLength(0);
  });

  it('支不存在 → 先建支再追加', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', `${REF}@dev`, '--file', file, '-m', 'on dev']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(createdBranches).toEqual(['dev']);
    expect(requestLog).toEqual(['branch', 'revision']);
    expect(revisionPosts).toHaveLength(1);
    expect(revisionPosts[0]!.branch).toBe('dev');
    expect('parent_hash' in revisionPosts[0]!.body).toBe(false);
    expect(out.stdout).toMatch(/pushed:\s+tester\/direct-p@dev v3/);
  });
});

describe('commit 直写 hub：--amend', () => {
  it('force 请求体：旧头的根换成新根、message 按给定、documents 只有新文档、其他支落对位置', async () => {
    seedTwoRevs();
    // feat 指着 v1（不是旧头）→ 指针不动
    branchChains.set('feat', [revisionOf(1, r1, null, 'first revision')]);
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'amend.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'amended message', '--amend']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`amended:\\s+${REF}@main v2\\s+${r3.slice(7, 19)}\\s+amended message`));
    expect(revisionPosts).toHaveLength(1);
    const post = revisionPosts[0]!;
    expect(post.force).toBe(true);
    const commits = post.body.commits as { root_hash: string; parent_hash: string | null; message: string }[];
    expect(commits.map((c) => c.root_hash)).toEqual([r3, r1]); // 旧头 r2 被替换、不在链上
    expect(commits[0]).toEqual({ root_hash: r3, parent_hash: r1, message: 'amended message' });
    expect(commits[1]).toEqual({ root_hash: r1, parent_hash: null, message: 'first revision' });
    expect(post.body.documents).toEqual([{ root_hash: r3, document: DOC3 }]);
    expect(post.body.branches).toEqual({ main: r3, feat: r1 });
  });

  it('不给 -m：沿用被替换那条的原说明；单支实例上旧版本全带进新链', async () => {
    seedTwoRevs(); // 只有 main 一条支：v1 → v2，替换 v2
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'amend.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '--amend']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    // 新提交接在 v1 后面，v1 自己也在链上——少了它真 hub 会判「链断了」
    expect(revisionPosts[0]!.body.commits).toEqual([
      { root_hash: r3, parent_hash: r1, message: 'second revision' },
      { root_hash: r1, parent_hash: null, message: 'first revision' },
    ]);
    expect(out.stdout).toMatch(/second revision/); // 输出行带沿用说明
    // mock 按 payload 重建后：log 看到的是 v1 → 新版本（r2 已不在链上）
    const after = await pop(home, ['log', REF, '--json']);
    expect(after.code).toBe(0);
    const roots = (JSON.parse(after.stdout).revisions as { root_hash: string }[]).map((x) => x.root_hash);
    expect(roots).toEqual([r3, r1]);
  });

  it('指着旧头的其他支落到旧头的 parent_hash', async () => {
    seedTwoRevs();
    // feat 指着旧头 v2 → amend 后落到 v2 的 parent = v1
    branchChains.set('feat', [revisionOf(2, r2, r1, 'second revision')]);
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'amend.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'amended', '--amend']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(revisionPosts[0]!.body.branches).toEqual({ main: r3, feat: r1 });
  });

  it('发请求前复查支头：第二次取视图时换了头 → 中止，零写请求', async () => {
    seedTwoRevs();
    swapHeadOnViewNo = 2; // #1 初取视图、#2 复查 → 复查时模拟有人先推
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'amend.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'amended', '--amend']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/moved while this document was being prepared/);
    expect(out.stderr).toMatch(/practi show/);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('空支上 --amend → 报错「没有可替换的版本」', async () => {
    resetHub(); // 实例在，main 空链
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'amend.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'amended', '--amend']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/has no revisions to amend/);
    expect(revisionPosts).toHaveLength(0);
  });
});

describe('commit 直写 hub：--force', () => {
  it('请求体只有一条提交（parent null、支表只留目标支）；输出带 dropped 与不可达声明', async () => {
    seedTwoRevs();
    forceDropped = 2;
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'fresh.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '-m', 'fresh start', '--force']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(revisionPosts).toHaveLength(1);
    const post = revisionPosts[0]!;
    expect(post.force).toBe(true);
    expect(post.body.commits).toEqual([{ root_hash: r3, parent_hash: null, message: 'fresh start' }]);
    expect(post.body.documents).toEqual([{ root_hash: r3, document: DOC3 }]);
    expect(post.body.branches).toEqual({ main: r3 });
    expect(out.stdout).toMatch(new RegExp(`forced:\\s+${REF}@main v1\\s+${r3.slice(7, 19)}\\s+fresh start`));
    expect(out.stdout).toMatch(/hub dropped 2 unreachable/);
    expect(out.stdout).toMatch(/no longer reachable/);
  });

  it('--amend 与 --force 同给 → 用法 + 退出 1，零请求', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'x.json', DOC3);
    const out = await pop(home, ['commit', REF, '--file', file, '--amend', '--force']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/mutually exclusive/);
    expect(out.stderr).toMatch(/usage: practi commit/);
    expect(requestLog).toEqual([]);
    expect(revisionPosts).toHaveLength(0);
  });

  it('没给 --file → 用法 + 退出 1，零请求', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const out = await pop(home, ['commit', REF, '-m', 'x']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/--file/);
    expect(out.stderr).toMatch(/usage: practi commit/);
    expect(requestLog).toEqual([]);
  });
});

describe('new --file：hub 上诞生实例', () => {
  it('先 POST /instances 再 POST revisions（parent_hash null）；不建任何文件夹', async () => {
    resetHub({ instance: false });
    const home = await hubHome();
    const parent = tempDataDir();
    const file = writeDoc(parent, 'first.json', DOC3);
    const out = await runIn(parent, home, ['new', NAME, '--file', file, '-m', 'first']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(createdInstances).toEqual([{ name: NAME, visibility: 'PRIVATE' }]);
    expect(revisionPosts).toHaveLength(1);
    expect(revisionPosts[0]!.branch).toBe('main');
    expect(revisionPosts[0]!.body.parent_hash).toBeNull();
    expect(revisionPosts[0]!.body.message).toBe('first');
    expect(revisionPosts[0]!.body.document).toEqual(DOC3);
    expect(requestLog).toEqual(['instances', 'revision']);
    expect(fs.existsSync(path.join(parent, NAME))).toBe(false);
    expect(out.stdout).toMatch(new RegExp(`created on the hub: ${REF}  \\(PRIVATE\\)`));
    expect(out.stdout).toMatch(new RegExp(`pushed:\\s+${REF}@main v1\\s+${r3.slice(7, 19)}\\s+first`));
    expect(out.stdout).toMatch(new RegExp(`practi visibility ${REF} public`));
  });

  it('重名 409 → 提示 practi commit <owner>/<name> --file', async () => {
    resetHub(); // 实例已存在
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'first.json', DOC3);
    const out = await pop(home, ['new', NAME, '--file', file, '-m', 'first']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/already exists under tester/);
    expect(out.stderr).toMatch(new RegExp(`practi commit ${REF} --file`));
    expect(revisionPosts).toHaveLength(0);
    expect(createdInstances).toHaveLength(1);
  });

  it('坏文档 → 零请求', async () => {
    resetHub({ instance: false });
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'broken.json', DOC_E);
    const out = await pop(home, ['new', NAME, '--file', file]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/E_SCHEMA/);
    expect(createdInstances).toHaveLength(0);
    expect(revisionPosts).toHaveLength(0);
    expect(requestLog).toEqual([]);
  });

  it('--file 与 --base 同给 → 用法 + 退出 1', async () => {
    const home = await hubHome();
    const file = writeDoc(tempDataDir(), 'first.json', DOC3);
    const out = await pop(home, ['new', NAME, '--file', file, '--base', file]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/mutually exclusive/);
    expect(requestLog).toEqual([]);
  });
});

describe('blob add 直传 hub', () => {
  it('PUT body 就是文件字节；条目与本地算法一致（name/hash/mime/size）', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const dir = tempDataDir();
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, BLOB_BYTES);
    const out = await pop(home, ['blob', 'add', REF, file]);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(blobWrites.get(FIG_HASH)).toBeTruthy();
    expect(blobWrites.get(FIG_HASH)!.equals(BLOB_BYTES)).toBe(true);
    expect(out.stdout).toMatch(new RegExp(`uploaded:  ${FIG_HASH}  \\(on the hub\\)`));
    const entry = JSON.parse(out.stdout.match(/\{[^{}]*\}/s)![0]);
    expect(entry).toEqual({ name: 'fig.png', hash: FIG_HASH, mime: 'image/png', size: BLOB_BYTES.length });
  });

  it('hub 拒绝 → 打印原因，退出 1', async () => {
    seedTwoRevs();
    const home = await hubHome();
    const dir = tempDataDir();
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, BLOB_BYTES);
    blobRejectOnce = 'rejected by the moderation gate';
    const out = await pop(home, ['blob', 'add', REF, file]);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/rejected by the moderation gate/);
    expect(blobWrites.size).toBe(0);
  });

  it('地址 owner 段不合法 → 用法错误，零请求', async () => {
    const home = await hubHome();
    const dir = tempDataDir();
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, BLOB_BYTES);
    const out = await pop(home, ['blob', 'add', 'Tester/direct-p', file]); // 大写不合法
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/needs its owner/);
    expect(requestLog).toEqual([]);
  });
});
