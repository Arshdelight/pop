import { resolveNodeRef, type Workspace } from '@arshdelight/pop-sdk';
import { openPool, chainHead, resolveRepo, type Repo } from '../practice.js';
import { shortHash } from '../render.js';
import { loadNotes, insertNote, updateNote, removeNote, subtreeHashes, type NoteEntry, type NoteMutation } from '../notes.js';

/**
 * practi note — 本地学习笔记（sidecar .practi/notes.json，不进协议）。
 * 钉在任一节点的哈希上，侧重学习/复现经验；子命令式、-m 带内容、--json 给 agent。
 */

export interface NoteOpts {
  dir?: string;
  positional: string[]; // [子命令, hash 或 note id]
  message?: string;
  json: boolean;
}

const USAGE = `usage: practi note add|list|edit|delete
  practi note add <node> -m "<text>" [--json]
                  pin a learning/reproduction note to a node hash (prefix OK; local only,
                  never uploaded)
  practi note list [hash] [--json]
                  no arg = all notes (grouped by owning document); hash = only notes within
                  that node's subtree
  practi note edit <note-id> -m "<new text>" [--json]
  practi note delete <note-id>`;

export function runNote(opts: NoteOpts): number {
  const repo = resolveRepo({ dir: opts.dir, verb: 'note' });
  if (repo === null) return 1;
  const sub = opts.positional[0];
  switch (sub) {
    case 'add':
      return noteAdd(opts, repo);
    case 'list':
      return noteList(opts, repo);
    case 'edit':
      return noteEdit(opts, repo.poolDir);
    case 'delete':
      return noteDelete(opts, repo.poolDir);
    default:
      console.error(USAGE);
      return 1;
  }
}

function noteAdd(opts: NoteOpts, repo: Repo): number {
  const target = opts.positional[1];
  if (!target || !opts.message || !opts.message.trim()) {
    console.error('usage: practi note add <node> -m "<text>"');
    return 1;
  }
  // 存在性校验兼前缀解析：笔记必须钉在池里已有的节点上（挡手滑哈希）
  const ws = openPool(repo);
  const hash = resolveNodeRef(ws, target);
  const note = insertNote(repo.poolDir, hash, opts.message);
  if (opts.json) {
    console.log(JSON.stringify(note, null, 2));
    return 0;
  }
  console.log(`noted on ${shortHash(hash)} — id ${note.id}`);
  return 0;
}

function noteList(opts: NoteOpts, repo: Repo): number {
  const target = opts.positional[1];
  const file = loadNotes(repo.poolDir);
  let notes = file.notes;

  if (target) {
    const ws = openPool(repo);
    const hash = resolveNodeRef(ws, target);
    const set = subtreeHashes(ws, hash);
    notes = notes.filter(n => set.has(n.hash));
  }
  if (opts.json) {
    // 机器窗：按存入顺序（时间正序）平铺，不分组——分组是人看的
    console.log(JSON.stringify(notes, null, 2));
    return 0;
  }
  if (notes.length === 0) {
    console.log(target ? 'no notes in this subtree' : 'no notes');
    return 0;
  }
  if (target) {
    const ws2 = openPool(repo);
    printNotes(notes, h => ws2.nodes.get(h)?.name ?? shortHash(h));
    return 0;
  }
  // 无参：按所属文档分组（组内时间正序=学习轨迹，组按最新笔记倒序=最近在学的在前）；
  // 实例的「所属文档」就是当前支头，钉在已换根历史节点上的笔记归入悬空组殿后
  const ws = openPool(repo);
  const head = chainHead(repo.chain);
  const roots = head !== null && ws.nodes.has(head) ? [head] : [];
  const claimed = new Set<string>();
  const groups: { title: string; items: NoteEntry[] }[] = [];
  for (const root of roots) {
    const set = subtreeHashes(ws, root);
    const items = notes.filter(n => set.has(n.hash));
    if (!items.length) continue;
    for (const n of items) claimed.add(n.id);
    groups.push({ title: groupTitle(ws, root), items });
  }
  const dangling = notes.filter(n => !claimed.has(n.id));
  if (dangling.length) {
    groups.push({ title: `dangling (${dangling.length})`, items: dangling });
  }
  groups.sort((a, b) => newest(b.items).localeCompare(newest(a.items)));
  for (const g of groups) {
    console.log(`\n${g.title}`);
    printNotes(g.items, h => ws.nodes.get(h)?.name ?? shortHash(h));
  }
  return 0;
}

function groupTitle(ws: Workspace, root: string): string {
  const node = ws.nodes.get(root);
  const tag = node ? (node.type === 'practice' ? `practice·${node.op}` : 'action') : '';
  return `${node?.name ?? '?'}  [${tag}]  ${shortHash(root)}`;
}

function newest(items: NoteEntry[]): string {
  return items.reduce((acc, n) => (n.createdAt > acc ? n.createdAt : acc), '');
}

function printNotes(notes: NoteEntry[], label: (hash: string) => string): void {
  for (const n of notes) {
    console.log(`  ${n.id}  ${fmtLocal(n.createdAt)}  ${label(n.hash)}`);
    for (const line of n.content.split('\n')) console.log(`      ${line}`);
  }
}

/** ISO → 本地时区 YYYY-MM-DD HH:mm（个人日记口径：时间属于看的人） */
function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x: number) => (x < 10 ? '0' : '') + x;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function reportMutation(id: string, m: NoteMutation): number {
  if (!m.ok) {
    if (m.reason === 'not_found') console.error(`error: note "${id}" not found`);
    else console.error(`error: note id prefix "${id}" matches ${m.matches} notes`);
    return 1;
  }
  return 0;
}

function noteEdit(opts: NoteOpts, poolDir: string): number {
  const id = opts.positional[1];
  if (!id || !opts.message || !opts.message.trim()) {
    console.error('usage: practi note edit <note-id> -m "<new text>"');
    return 1;
  }
  const m = updateNote(poolDir, id, opts.message);
  if (!m.ok) return reportMutation(id, m);
  if (opts.json) {
    console.log(JSON.stringify(m.note, null, 2));
    return 0;
  }
  console.log(`note ${m.note.id} edited`);
  return 0;
}

function noteDelete(opts: NoteOpts, poolDir: string): number {
  const id = opts.positional[1];
  if (!id) {
    console.error('usage: practi note delete <note-id>');
    return 1;
  }
  const m = removeNote(poolDir, id);
  if (!m.ok) return reportMutation(id, m);
  console.log(`note ${m.note.id} deleted`);
  return 0;
}
