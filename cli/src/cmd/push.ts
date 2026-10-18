import { exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch, fetchMine } from '../client.js';

export interface PushOpts {
  dataDir?: string;
  positional: string[];
  /** 绑定分支头时用哪条支（缺省=工作区绑定的当前支；需已 `practi instance bind`） */
  branch?: string;
}

/**
 * hub 政策（2026-09-03）：hub 不收附件指针 url（E_ATTACH_URL 整篇拒收）——push 前置空。
 * url 不进哈希（§3.2 剥离），置空不改变 root_hash/文档身份；纯函数重建，本地工作区
 * 原件保留 url（溯源）。
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

/**
 * practi push [hash] [--branch <b>]：本地认领增量推送 + 绑实例分支头（git push 语义）。
 * - 对象协商：先分页取 hub 上「我的」认领表（mine），只传 hub 还没有的（内容寻址幂等，
 *   hub 没有就存、有则 idempotent）。
 * - 分支绑定：工作区已绑实例（state.instance）时，把推送的根绑为该支新头——
 *   绑定目标是显式 hash（单一 direct 时免参）；fast-forward 校验在服务端
 *   （E_NOT_FAST_FORWARD = 分支头不是新头的直接修订，先 merge/变基）。
 *   **未绑实例=拒绝推送**（2026-10-18 用户拍板）：pop 在 hub 上只以实践实例的形式
 *   存放——pop_documents/认领表只是对象存储（哈希存内容的途径），不是入库正门；
 *   先 `practi instance create|bind` 再 push。
 */
export async function runPush(opts: PushOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  if (!state.instance) {
    console.error('error: no instance bound — POP lives on the hub only as practice instances');
    console.error('       run `practi instance create <name>` or `practi instance bind <owner>/<name>` first');
    return 1;
  }
  const ws = openWorkspace(dataDir);
  const targets = opts.positional[0] ? [opts.positional[0]] : state.direct;
  if (targets.length === 0) {
    console.error('error: no direct pops to push (none registered)');
    return 1;
  }

  // 认领表 diff 的基准：hub 上我已认领的 hash 集合
  let mineHashes: Set<string>;
  try {
    const mine = await fetchMine(dataDir, state.remote.url);
    mineHashes = new Set(mine.map((r) => r.root_hash));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  // 解析目标为完整 hash，只保留本地认领而 hub 我还没认领的（增量）
  const toPush: string[] = [];
  const resolvedTargets: string[] = [];
  let failed = 0;
  for (const ref of targets) {
    let resolved: string;
    try {
      resolved = resolveNodeRef(ws, ref);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      failed++;
      continue;
    }
    if (!state.direct.includes(resolved)) {
      console.error(`push failed: ${ref} — ${resolved} is not one of your direct pops (push exports YOUR direct roots; indirect nodes travel inside them)`);
      failed++;
      continue;
    }
    resolvedTargets.push(resolved);
    if (!mineHashes.has(resolved)) toPush.push(resolved);
  }
  if (toPush.length === 0 && resolvedTargets.length > 0) {
    console.log('up to date — no new direct pops to push');
  }

  for (const ref of toPush) {
    try {
      const node = ws.nodes.get(ref);
      if (!node) throw new Error(`node not found: ${ref}`);
      const doc = stripAttachmentUrls(exportSubtree(node, ws.nodes));
      const res = await authedFetch(dataDir, state.remote.url, '/api/v1/pop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      });
      const body = await res.json();
      if (!res.ok) {
        const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        console.error(`push failed: ${ref} — ${detail}`);
        failed++;
        continue;
      }
      const name = (doc as { name?: string }).name ?? '';
      const status = String(body.status ?? 'PRIVATE');
      console.log(`pushed:  ${ref}  (${body.idempotent ? 'already existed' : 'stored'}, ${status})  ${name}`);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      failed++;
    }
  }

  // 分支绑定（存完后做）：目标 hash=显式给定的那个；多个 direct 时无法猜头，提示显式传
  const bound = { ...state.instance, ...(opts.branch !== undefined ? { branch: opts.branch } : {}) };
  const tipHash = opts.positional[0]
    ? resolvedTargets[0]
    : resolvedTargets.length === 1
      ? resolvedTargets[0]
      : null;
  if (!tipHash) {
    console.error(`note: instance ${bound.owner}/${bound.name} is bound — pass <hash> to bind the branch head (multiple directs, not guessing)`);
    return failed ? 1 : 0;
  }
  try {
    const res = await authedFetch(
      dataDir,
      state.remote.url,
      `/api/v1/instances/${encodeURIComponent(bound.owner)}/${encodeURIComponent(bound.name)}/branches/${encodeURIComponent(bound.branch)}/head`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root_hash: tipHash }),
      }
    );
    const body = await res.json();
    if (res.ok) {
      console.log(`bound:   ${bound.owner}/${bound.name}@${bound.branch} → ${tipHash}`);
    } else if (body.code === 'E_NOT_FAST_FORWARD') {
      console.error(`bind failed: ${bound.branch}'s head is not ${tipHash}'s direct revision — merge or rebase first (\`practi merge\`, \`practi switch\`)`);
      failed++;
    } else {
      const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      console.error(`bind failed: ${detail}`);
      failed++;
    }
  } catch (e) {
    console.error(`bind failed: ${(e as Error).message}`);
    failed++;
  }
  return failed ? 1 : 0;
}
