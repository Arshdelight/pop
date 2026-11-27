import { exportSubtree, resolveNodeRef, createFromDoc, readBlob } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, remoteUrl, type State } from '../state.js';
import { authedFetch, collectAttachmentHashes, uploadBlob, blobOnHub } from '../client.js';
import { shortHash } from '../render.js';
import {
  chainHead,
  openPool,
  resolveRepo,
  saveChain,
  type ChainCommit,
  type Repo,
} from '../practice.js';

export interface PushOpts {
  dataDir?: string;
  /** 定位覆盖：实例文件夹（--dir）；缺省=cwd 向上找 .practi */
  dir?: string;
  /** 强推：本地链覆盖远端支头（hub 清不可达对象）；分叉时必须 */
  force?: boolean;
}

/**
 * hub 政策（2026-09-03）：hub 不收附件指针 url（E_ATTACH_URL 整篇拒收）——push 前置空。
 * url 不进哈希（§3.2 剥离），置空不改变 root_hash/文档身份；纯函数重建，本地原件保留 url。
 */
export function stripAttachmentUrls<T>(node: T): T {
  const out = { ...(node as Record<string, unknown>) };
  if (Array.isArray(out.attachments)) {
    out.attachments = (out.attachments as Record<string, unknown>[]).map(
      ({ url: _url, ...rest }) => rest,
    );
  }
  if (Array.isArray(out.children)) {
    out.children = (out.children as unknown[]).map(stripAttachmentUrls);
  }
  return out as unknown as T;
}

function detailOf(body: Record<string, unknown>, status: number): string {
  return typeof body.message === 'string'
    ? body.message
    : typeof body.error === 'string'
      ? body.error
      : `HTTP ${status}`;
}

/** hub E_BLOB_MISSING 应答里的缺失 hash 列表（body.missing；非该错误/无数组 → null） */
function missingBlobsOf(body: Record<string, unknown>): string[] | null {
  if (body.code !== 'E_BLOB_MISSING' || !Array.isArray(body.missing)) return null;
  const hashes = body.missing.filter((h): h is string => typeof h === 'string' && h !== '');
  return hashes.length > 0 ? hashes : null;
}

/** 把本地池里的缺失 blob 逐个 PUT 上 hub（blob 正门，2026-11-18）。
 *  返回 null = 全部就绪；字符串 = 给用户看的失败原因（本地无字节/上传被拒）。 */
async function ensureRemoteBlobs(
  hashes: string[],
  repo: Repo,
  ctx: { dataDir: string; remote: string; verbose?: boolean }
): Promise<string | null> {
  for (const hash of hashes) {
    const bytes = readBlob(repo.poolDir, hash);
    if (bytes === null) {
      return `blob ${hash.slice(0, 13)}… is referenced by the document but has no local bytes — re-add it with \`practi blob add <file>\``;
    }
    const err = await uploadBlob(ctx.dataDir, ctx.remote, hash, bytes);
    if (err !== null) return err;
    if (ctx.verbose) console.log(`  blob ${shortHash(hash)} uploaded`);
  }
  return null;
}

/** 实例在 hub 侧不存在时创建（首次 push 诞生），回填 owner。
 *  幂等：hub 已有同名实例（换机器重推/上次创建后中断）→ owner=登录账号（实例名
 *  归属于本人命名空间）。 */
async function ensureHubInstance(repo: Repo, dataDir: string, remote: string, state: State): Promise<string | null> {
  const res = await authedFetch(dataDir, remote, '/api/v1/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: repo.chain.name, visibility: 'PRIVATE' }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    const owner = typeof body.owner === 'string' && body.owner !== '' ? body.owner : null;
    if (owner === null) {
      console.error('push failed: the hub accepted the instance but did not name its owner (hub version too old for the two-software model?)');
      return null;
    }
    repo.chain.owner = owner;
    return owner;
  }
  // 已有同名实例（E_DUPLICATE）→ 归属本人：owner=登录账号
  if (res.status === 409 || body.code === 'E_DUPLICATE') {
    const me = await authedFetch(dataDir, remote, '/api/auth/me');
    const meBody = (await me.json().catch(() => ({}))) as { username?: unknown };
    if (me.ok && typeof meBody.username === 'string' && meBody.username !== '') {
      repo.chain.owner = meBody.username;
      return meBody.username;
    }
    console.error('push failed: an instance with that name already exists and it is not yours — pick another practice name');
    return null;
  }
  console.error(`push failed: creating the instance on the hub — ${detailOf(body, res.status)}`);
  return null;
}

/** 从实例节点池导出某 root 的完整文档（附件 url 剥离） */
function exportDoc(repo: Repo, root: string): unknown | null {
  try {
    const ws = openPool(repo);
    const node = ws.nodes.get(root);
    if (!node) return null;
    return stripAttachmentUrls(exportSubtree(node, ws.nodes));
  } catch {
    return null;
  }
}

/**
 * 把实例仓库同步到 hub（push/publish 共用核心）：
 * - 首推：hub 无此实例则创建（owner 回填）
 * - FF：待推路径=从本地支头沿 parent 走到 hub 头（反序逐条 POST revisions）
 * - 分叉：hub 头不在本地链 → 报错（--force 走 force 全链端点，hub 重建+清不可达）
 */
export async function pushRepo(
  repo: Repo,
  opts: { dataDir: string; remote: string; force?: boolean; verbose?: boolean }
): Promise<number> {
  const state = loadState(opts.dataDir);
  // 首推：hub 无此实例 → 创建（owner 回填；publish/push 共用的诞生门）
  if (repo.chain.owner === null) {
    const owner = await ensureHubInstance(repo, opts.dataDir, opts.remote, state);
    if (owner === null) return 1;
    saveChain(repo);
    console.log(`created on the hub: ${owner}/${repo.chain.name}  (PRIVATE)`);
    console.log(`  invisible to others — request publication with: practi visibility ${owner}/${repo.chain.name} public`);
  }
  const { owner: bindOwner, name } = repo.chain;
  const base = `/api/v1/instances/${encodeURIComponent(bindOwner ?? '')}/${encodeURIComponent(name)}`;
  const branch = repo.chain.current;
  const head = chainHead(repo.chain);

  // 远端链视图（对账基准）。本地新建的支 hub 侧还没有支行，视图对显式未知支名
  // 诚实 404（E_BRANCH_NOT_FOUND）——分支先在本地诞生（本地链权威），据此建支后重取。
  let viewRes = await authedFetch(opts.dataDir, opts.remote, `${base}?branch=${encodeURIComponent(branch)}`);
  let view = (await viewRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!viewRes.ok && view.code === 'E_BRANCH_NOT_FOUND') {
    const mk = await authedFetch(opts.dataDir, opts.remote, `${base}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: branch }),
    });
    if (!mk.ok) {
      const mkBody = (await mk.json().catch(() => ({}))) as Record<string, unknown>;
      console.error(`push failed: creating branch "${branch}" on the hub — ${detailOf(mkBody, mk.status)}`);
      return 1;
    }
    if (opts.verbose) console.log(`  branch created on the hub: ${branch}`);
    viewRes = await authedFetch(opts.dataDir, opts.remote, `${base}?branch=${encodeURIComponent(branch)}`);
    view = (await viewRes.json().catch(() => ({}))) as Record<string, unknown>;
  }
  if (!viewRes.ok) {
    console.error(`push failed: ${detailOf(view, viewRes.status)}`);
    return 1;
  }
  const hubHead = typeof view.branch_head_hash === 'string' ? view.branch_head_hash : null;

  if (hubHead === head) {
    const dirtyChain = repo.chain.commits.some((c) => c.pushedAt === undefined);
    if (dirtyChain) {
      // 头相同但本地链元数据被重写过（reword/squash 后清戳）——FF 推不上去；
      // --force 走 force 端点同步链元数据（root_hash 未变的内容幂等保留，只落新 message）
      if (opts.force !== true) {
        console.error(
          `push rejected: the head matches the hub, but your local chain was rewritten (history edit) —` +
            ` \`practi push --force\` to sync the chain metadata (the hub drops unreachable objects)`
        );
        return 1;
      }
      return forcePush(repo, { dataDir: opts.dataDir, remote: opts.remote, base, branch, hubHead });
    }
    console.log(`up to date — ${name}@${branch} → ${shortHash(head ?? '')}`);
    return 0;
  }

  // 待推路径：从支头沿 parent 回溯到 hubHead（hubHead=null=全链）
  const byRoot = new Map(repo.chain.commits.map((c) => [c.root, c]));
  const path: ChainCommit[] = [];
  let cursor = head;
  let diverged = false;
  while (cursor !== null && cursor !== hubHead) {
    const c = byRoot.get(cursor);
    if (!c) {
      diverged = true;
      break;
    }
    path.unshift(c);
    cursor = c.parent;
  }
  if (cursor !== hubHead) diverged = true; // 走到链尾仍不是 hub 头 = 分叉（hub 有本地没有的历史）
  if (diverged) {
    if (opts.force !== true) {
      console.error(
        `push rejected: the hub's ${name}@${branch} is at ${shortHash(hubHead ?? '')}, which is not in your local chain —` +
          ` the histories have diverged. Rewrite to match, or force with \`practi push --force\` (the hub drops unreachable objects)`
      );
      return 1;
    }
    return forcePush(repo, { dataDir: opts.dataDir, remote: opts.remote, base, branch, hubHead });
  }

  if (path.length === 0) {
    console.log(`up to date — ${name}@${branch} → ${shortHash(head ?? '')}`);
    return 0;
  }

  // FF 逐条推（服务端 parent=当前支头自动落链）。附件字节缺失（E_BLOB_MISSING）时
  // 自动从本地池补传后重推一次——正常路径零额外请求，blob 已在 hub 的重复推送无感
  for (const c of path) {
    const doc = exportDoc(repo, c.root);
    if (doc === null) {
      console.error(`push failed: node not found in the practice pool: ${c.root}`);
      return 1;
    }
    const post = () =>
      authedFetch(opts.dataDir, opts.remote, `${base}/branches/${encodeURIComponent(branch)}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c.message !== '' ? { document: doc, message: c.message } : { document: doc }),
      });
    let res = await post();
    let body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const missing = res.ok ? null : missingBlobsOf(body);
    if (missing !== null) {
      const err = await ensureRemoteBlobs(missing, repo, opts);
      if (err !== null) {
        console.error(`push failed at v${c.seq} (${shortHash(c.root)}): ${err}`);
        return 1;
      }
      res = await post();
      body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    }
    if (!res.ok) {
      console.error(`push failed at v${c.seq} (${shortHash(c.root)}): ${detailOf(body, res.status)}`);
      return 1;
    }
    c.pushedAt = new Date().toISOString();
    if (opts.verbose) console.log(`  v${c.seq}  ${shortHash(c.root)}  ${c.message}`);
  }
  saveChain(repo);
  console.log(`pushed:  ${path.length} revision(s) — ${name}@${branch} → ${shortHash(head ?? '')}  (v${path[path.length - 1].seq})`);
  return 0;
}

/** force：本地全链+缺失文档一次性上传，hub 重建支链并清除不可达对象 */
async function forcePush(
  repo: Repo,
  ctx: { dataDir: string; remote: string; base: string; branch: string; hubHead: string | null }
): Promise<number> {
  const commits = repo.chain.commits.map((c) => ({
    seq: c.seq,
    root_hash: c.root,
    parent_hash: c.parent,
    message: c.message,
  }));
  // 支指针表随链上传（hub 侧全部支都必须落在新链上，悬空指针拒收）
  const branches: Record<string, string | null> = {};
  for (const [b, r] of Object.entries(repo.chain.branches)) branches[b] = r;
  // 只随链上传 hub 可能缺的文档：无法确知，干脆全带（内容寻址，hub 幂等）
  const documents: { root_hash: string; document: unknown }[] = [];
  for (const c of repo.chain.commits) {
    const doc = exportDoc(repo, c.root);
    if (doc !== null) documents.push({ root_hash: c.root, document: doc });
  }
  // blob 预检（批量首缺失即整单拒收，逐批重试太贵）：全链附件 hash 逐个探在架，
  // 缺的从本地池补传后再整批推
  const allHashes = new Set<string>();
  for (const d of documents) collectAttachmentHashes(d.document, allHashes);
  const missing: string[] = [];
  for (const hash of allHashes) {
    try {
      if (!(await blobOnHub(ctx.remote, hash))) missing.push(hash);
    } catch (e) {
      console.error(`force push failed: probing blob ${shortHash(hash)} — ${(e as Error).message}`);
      return 1;
    }
  }
  if (missing.length > 0) {
    const err = await ensureRemoteBlobs(missing, repo, { dataDir: ctx.dataDir, remote: ctx.remote, verbose: true });
    if (err !== null) {
      console.error(`force push failed: ${err}`);
      return 1;
    }
  }
  const res = await authedFetch(ctx.dataDir, ctx.remote, `${ctx.base}/branches/${encodeURIComponent(ctx.branch)}/revisions?force=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commits, documents, branches }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`force push failed: ${detailOf(body, res.status)}`);
    return 1;
  }
  const now = new Date().toISOString();
  for (const c of repo.chain.commits) c.pushedAt = now;
  saveChain(repo);
  const dropped = typeof body.dropped === 'number' ? body.dropped : 0;
  console.log(
    `forced:  ${repo.chain.commits.length} revision(s) — ${repo.chain.name}@${ctx.branch} → ${shortHash(repo.chain.branches[ctx.branch] ?? '')}` +
      (dropped > 0 ? `  (hub dropped ${dropped} unreachable revision(s))` : '')
  );
  return 0;
}

/**
 * practi push [--force] [--dir <path> | --practice <name>]：本地实例 → hub。
 * 首推在 hub 诞生实例（此前它只在本地）；FF 逐条推；分叉报错，--force 用本地链
 * 覆盖远端支头（hub 清不可达对象——spec §9.1 留存按链可达性的落地）。
 */
export async function runPush(opts: PushOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const repo = resolveRepo({ dir: opts.dir, verb: 'push' });
  if (repo === null) return 1;
  const head = chainHead(repo.chain);
  if (head === null) {
    console.error(`error: practice "${repo.chain.name}" has no revisions yet — \`practi publish <pop> --to ${repo.chain.name}\` first`);
    return 1;
  }
  return pushRepo(repo, { dataDir, remote: remoteUrl(dataDir), force: opts.force, verbose: true });
}
