import { exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';
import { markPushed, messageFor } from '../commits.js';

export interface PushOpts {
  dataDir?: string;
  positional: string[];
  /** 绑定分支头时用哪条支（缺省=工作区绑定的当前支；需已 `practi instance bind`） */
  branch?: string;
  /** 提交说明（缺省取本地提交日志里该根的 message，再缺省由 hub 记空） */
  message?: string;
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
 * practi push [hash] [--branch <b>] [--message <text>]：存文档 + 绑分支头（一个调用，git push 语义）。
 * - **pop 在 hub 上只以实践实例的形式存放**（2026-10-18 用户拍板）：未绑实例=拒绝，
 *   不再有无实例的认领兜底；本地 pop 由 CLI 像编辑器一样管理，同步单元只有实例。
 * - 提交说明（message）随请求上送，落 hub 的实例提交链（POP 2.0 §9.1 仓库层历史）；
 *   缺省取 edit 记下的本地提交日志（commits.json），成功后本地条目盖 pushedAt。
 * - 服务端幂等：同内容重复 push 命中已存文档（idempotent），重推当前支头=up to date；
 *   父链由服务端按当前支头落库（线性血统由构造保证，push 无需声明 base）。
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

  // 绑定目标=显式给定的那个 root；多个 direct 时无法猜头，要求显式传（先解析后联网）
  const resolvedTargets: string[] = [];
  for (const ref of opts.positional[0] ? [opts.positional[0]] : state.direct) {
    try {
      const resolved = resolveNodeRef(ws, ref);
      if (!state.direct.includes(resolved)) {
        console.error(`push failed: ${ref} — ${resolved} is not one of your direct pops (push exports YOUR direct roots; indirect nodes travel inside them)`);
        return 1;
      }
      resolvedTargets.push(resolved);
    } catch (e) {
      console.error(`push failed: ${ref} — ${(e as Error).message}`);
      return 1;
    }
  }
  if (resolvedTargets.length === 0) {
    console.error('error: no direct pops to push (none registered)');
    return 1;
  }
  if (resolvedTargets.length > 1) {
    console.error(`error: ${resolvedTargets.length} direct pops registered — pass <hash> to choose the revision to push (one push = one branch head)`);
    return 1;
  }
  const tipHash = resolvedTargets[0];

  const node = ws.nodes.get(tipHash);
  if (!node) {
    console.error(`push failed: node not found: ${tipHash}`);
    return 1;
  }
  const doc = stripAttachmentUrls(exportSubtree(node, ws.nodes));
  const bound = { ...state.instance, ...(opts.branch !== undefined ? { branch: opts.branch } : {}) };
  const message = opts.message ?? messageFor(dataDir, tipHash);

  let res;
  try {
    res = await authedFetch(
      dataDir,
      state.remote.url,
      `/api/v1/instances/${encodeURIComponent(bound.owner)}/${encodeURIComponent(bound.name)}/branches/${encodeURIComponent(bound.branch)}/revisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message !== undefined ? { document: doc, message } : { document: doc }),
      },
    );
  } catch (e) {
    console.error(`push failed: ${(e as Error).message}`);
    return 1;
  }
  const body = await res.json();
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`push failed: ${detail}`);
    return 1;
  }

  const name = (doc as { name?: string }).name ?? '';
  if (body.already_head === true) {
    console.log(`up to date — ${shortHash(String(body.root_hash))} is already the head of ${bound.branch} (v${body.seq})`);
    return 0;
  }
  console.log(`pushed:  ${tipHash}  (${body.idempotent ? 'already existed' : 'stored'}, ${body.status ?? 'PRIVATE'})  ${name}`);
  console.log(`bound:   ${bound.owner}/${bound.name}@${bound.branch} → ${String(body.root_hash)}  (v${body.seq})`);
  markPushed(dataDir, tipHash);
  return 0;
}
