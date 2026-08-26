import { defaultDataDir, loadState } from '../state.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';
import {
  COMMENT_VALENCES,
  COMMENT_REPORT_REASONS,
  type CommentListResult,
  type PopComment,
} from '@arshdelight/pop-sdk';

/**
 * pop comment — POP 节点评论（hub 扩展端点，2026-08-26；不参与协议）。
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

const USAGE = `usage: pop comment list|tally|add|edit|delete|report
  pop comment list <hash> [--node <hash>] [--cursor <c>] [--limit N] [--json]
                      看评论：整篇=该文档自己的评论；--node=某节点全网评论（含正反态度分布）
  pop comment tally <hash> [--node <hash>] [--json]
                      只看正反态度分布（支持/中立/反对计数）
  pop comment add <hash> --node <hash> --valence support|neutral|oppose -m "<评论内容>"
  pop comment edit <comment-id> -m "<新内容>"
  pop comment delete <comment-id>
  pop comment report <comment-id> --reason illegal|infringement|spam|other [--detail "..."]`;

function errDetail(body: { error?: string; message?: string }, status: number): string {
  return typeof body.message === 'string'
    ? body.message
    : typeof body.error === 'string'
      ? body.error
      : `HTTP ${status}`;
}

export async function runComment(opts: CommentOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
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
  if (!hash) {
    console.error('usage: pop comment list <hash> [--node <hash>] [--json]');
    return 1;
  }
  const params = new URLSearchParams();
  if (opts.node) params.set('node', opts.node);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', opts.limit);

  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(hash)}/comments?${params}`);
  const body = (await res.json().catch(() => ({}))) as CommentListResult & { error?: string; message?: string };
  if (!res.ok) {
    console.error(`comments failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  printTally(body.tally, hash);
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
  if (!hash) {
    console.error('usage: pop comment tally <hash> [--node <hash>] [--json]');
    return 1;
  }
  const params = new URLSearchParams({ limit: '1' });
  if (opts.node) params.set('node', opts.node);
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(hash)}/comments?${params}`);
  const body = (await res.json().catch(() => ({}))) as CommentListResult & { error?: string; message?: string };
  if (!res.ok) {
    console.error(`tally failed: ${errDetail(body, res.status)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body.tally, null, 2));
    return 0;
  }
  printTally(body.tally, hash);
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
  if (!hash || !opts.node || !opts.message) {
    console.error('usage: pop comment add <hash> --node <hash> --valence support|neutral|oppose -m "<评论内容>"');
    return 1;
  }
  const valence = (opts.valence ?? 'neutral').toUpperCase();
  if (!(COMMENT_VALENCES as readonly string[]).includes(valence)) {
    console.error('error: valence must be support | neutral | oppose');
    return 1;
  }
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(hash)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetHash: opts.node, valence, body: opts.message }),
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
  console.log(`commented on ${shortHash(opts.node)} [${valence}] — id ${body.id}`);
  return 0;
}

async function editComment(
  opts: CommentOpts,
  dataDir: string,
  remote: string,
  commentId?: string
): Promise<number> {
  if (!commentId || !opts.message) {
    console.error('usage: pop comment edit <comment-id> -m "<新内容>"');
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
    console.error('usage: pop comment delete <comment-id>');
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
    console.error('usage: pop comment report <comment-id> --reason illegal|infringement|spam|other [--detail "..."]');
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
