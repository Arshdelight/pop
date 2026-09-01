import { defaultDataDir, loadState } from '../state.js';
import { authedFetch, normalizeHashRef, requireCredentials } from '../client.js';
import { shortHash } from '../render.js';
import {
  COMMENT_VALENCES,
  COMMENT_REPORT_REASONS,
  type CommentListResult,
  type PopComment,
} from '@arshdelight/pop-sdk';

/**
 * practi comment — POP 节点评论（hub 扩展端点，2026-08-26；不参与协议）。
 * 扁平评论、每节点每人 1 条、色彩必选默认中立、先发后审（阿里 Green）。
 * 看评论：整篇=该文档自己的评论（来源 scoping）；--node 看某节点的全网评论（DAG 放大视图）。
 */

export interface CommentOpts {
  dataDir?: string;
  positional: string[]; // [子命令, hash 或 comment id]
  node?: string;
  cursor?: string;
  limit?: string;
  valence?: string;
  message?: string;
  reason?: string;
  detail?: string;
  json: boolean;
}

const VALENCE_BADGE: Record<string, string> = {
  SUPPORT: '[支持]',
  NEUTRAL: '[中立]',
  OPPOSE: '[反对]',
};

const USAGE = `usage: practi comment list|tally|add|edit|delete|report
  practi comment list <hash> [--node <hash>] [--cursor <c>] [--limit N] [--json]
                      看评论：整篇=该文档自己的评论；--node=某节点全网评论（含正反态度分布）
  practi comment tally <hash> [--node <hash>] [--json]
                      只看正反态度分布（支持/中立/反对计数）
  practi comment add <hash> --node <hash> --valence support|neutral|oppose -m "<评论内容>"
  practi comment edit <comment-id> -m "<新内容>"
  practi comment delete <comment-id>
  practi comment report <comment-id> --reason illegal|infringement|spam|other [--detail "..."]`;

function errDetail(body: { error?: string; message?: string }, status: number): string {
  return typeof body.message === 'string'
    ? body.message
    : typeof body.error === 'string'
      ? body.error
      : `HTTP ${status}`;
}

/** 统一哈希口径：评论对象可以是任何文档/节点（含他人的），前缀无处可靠解析——
 *  全哈希必收，带不带 sha256: 均可自动补。 */

/** 读公开评论匿名即可（与 show 的 hub 回落、search 远端半场同口径）；
 *  有凭据走 authed（未来 scope=me 之类有身份的读取不受影响）。 */
async function hubGet(dataDir: string, remote: string, path: string): Promise<Response> {
  const authed = (() => {
    try { requireCredentials(dataDir); return true; } catch { return false; }
  })();
  return authed ? authedFetch(dataDir, remote, path) : fetch(`${remote}${path}`);
}
function fullHash(label: string, ref?: string): string | null {
  if (!ref) return null;
  const full = normalizeHashRef(ref);
  if (!full) {
    console.error(`error: ${label} "${ref}" is not a full hash (with or without the sha256: prefix)`);
  }
  return full;
}

export async function runComment(opts: CommentOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const sub = opts.positional[0];
  const target = opts.positional[1];
  switch (sub) {
    case 'list':
      return listComments(opts, dataDir, state.remote.url, target);
    case 'tally':
      return tallyComments(opts, dataDir, state.remote.url, target);
    case 'add':
      return addComment(opts, dataDir, state.remote.url, target);
    case 'edit':
      return editComment(opts, dataDir, state.remote.url, target);
    case 'delete':
      return removeComment(opts, dataDir, state.remote.url, target);
    case 'report':
      return reportComment(opts, dataDir, state.remote.url, target);
    default:
      console.error(USAGE);
      return 1;
  }
}

async function listComments(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  hash?: string
): Promise<number> {
  const full = fullHash('hash', hash);
  if (!full) {
    console.error('usage: practi comment list <hash> [--node <hash>] [--json]');
    return 1;
  }
  const node = fullHash('--node', opts.node) ?? undefined;
  if (opts.node && !node) return 1;
  const params = new URLSearchParams();
  if (node) params.set('node', node);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', opts.limit);

  const res = await hubGet(dataDir, remote, `/api/v1/pop/${encodeURIComponent(full)}/comments?${params}`);
  const body = (await res.json().catch(() => ({}))) as CommentListResult & { error?: string; message?: string };
  if (!res.ok) {
    console.error(`comments failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  printTally(body.tally, full);
  if (body.items.length === 0) {
    console.log('no comments');
    return 0;
  }
  for (const c of body.items) printComment(c);
  if (body.nextCursor) {
    console.log(`\nmore — continue with --cursor ${body.nextCursor}`);
  }
  return 0;
}

async function tallyComments(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  hash?: string
): Promise<number> {
  const full = fullHash('hash', hash);
  if (!full) {
    console.error('usage: practi comment tally <hash> [--node <hash>] [--json]');
    return 1;
  }
  const node = fullHash('--node', opts.node) ?? undefined;
  if (opts.node && !node) return 1;
  const params = new URLSearchParams({ limit: '1' });
  if (node) params.set('node', node);
  const res = await hubGet(dataDir, remote, `/api/v1/pop/${encodeURIComponent(full)}/comments?${params}`);
  const body = (await res.json().catch(() => ({}))) as CommentListResult & { error?: string; message?: string };
  if (!res.ok) {
    console.error(`tally failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body.tally, null, 2));
    return 0;
  }
  printTally(body.tally, full);
  return 0;
}

function printTally(tally: CommentListResult['tally'], hash: string): void {
  const scope = tally.total === 0 ? '' : `（正反：${tally.SUPPORT} 支持 / ${tally.NEUTRAL} 中立 / ${tally.OPPOSE} 反对）`;
  console.log(`${shortHash(hash)} 共 ${tally.total} 条评论${scope}`);
}

function printComment(c: PopComment): void {
  const author = c.author.username ?? `${c.author.id.slice(0, 8)}…`;
  const hidden = c.reviewStatus === 'reject' ? '（已隐藏，可编辑后重发）' : '';
  console.log(`  ${shortHash(c.id)}  ${VALENCE_BADGE[c.valence] ?? c.valence}  @${author}  ${shortHash(c.targetHash)}${hidden}`);
  console.log(`      ${c.body}`);
}

async function addComment(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  hash?: string
): Promise<number> {
  const full = fullHash('hash', hash);
  const node = fullHash('--node', opts.node);
  if (!full || !node || !opts.message) {
    console.error('usage: practi comment add <hash> --node <hash> --valence support|neutral|oppose -m "<评论内容>"');
    return 1;
  }
  const valence = (opts.valence ?? 'neutral').toUpperCase();
  if (!(COMMENT_VALENCES as readonly string[]).includes(valence)) {
    console.error('error: valence must be support | neutral | oppose');
    return 1;
  }
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(full)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetHash: node, valence, body: opts.message }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
  if (!res.ok) {
    console.error(`comment failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  console.log(`commented on ${shortHash(node)} [${valence}] — id ${body.id}`);
  return 0;
}

async function editComment(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  commentId?: string
): Promise<number> {
  if (!commentId || !opts.message) {
    console.error('usage: practi comment edit <comment-id> -m "<新内容>"');
    return 1;
  }
  const res = await authedFetch(dataDir, remote, `/api/v1/comments/${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: opts.message }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
  if (!res.ok) {
    console.error(`edit failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  console.log(`comment ${commentId} edited`);
  return 0;
}

async function removeComment(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  commentId?: string
): Promise<number> {
  if (!commentId) {
    console.error('usage: practi comment delete <comment-id>');
    return 1;
  }
  const res = await authedFetch(dataDir, remote, `/api/v1/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
  const body = (await res.json().catch(() => ({}))) as { deleted?: boolean; error?: string; message?: string };
  if (!res.ok) {
    console.error(`delete failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  console.log(`comment ${commentId} deleted`);
  return 0;
}

async function reportComment(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  commentId?: string
): Promise<number> {
  if (!commentId || !opts.reason) {
    console.error('usage: practi comment report <comment-id> --reason illegal|infringement|spam|other [--detail "..."]');
    return 1;
  }
  const reason = opts.reason.toLowerCase();
  if (!(COMMENT_REPORT_REASONS as readonly string[]).includes(reason)) {
    console.error(`error: reason must be one of: ${COMMENT_REPORT_REASONS.join(' | ')}`);
    return 1;
  }
  const res = await authedFetch(dataDir, remote, `/api/v1/comments/${encodeURIComponent(commentId)}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason, detail: opts.detail ?? null }),
  });
  const body = (await res.json().catch(() => ({}))) as { updated?: boolean; error?: string; message?: string };
  if (!res.ok) {
    console.error(`report failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  console.log(body.updated ? `report updated for comment ${commentId}` : `comment ${commentId} reported`);
  return 0;
}
