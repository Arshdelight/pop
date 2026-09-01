import { resolveNodeRef, type Workspace } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';
import { loadNotes, saveNotes, newNoteId, subtreeHashes, type NoteEntry, type NotesFile } from '../notes.js';

/**
 * practi note — 本地学习笔记（sidecar notes.json，不进协议、不上 hub）。
 * 钉在任一节点的哈希上，侧重学习/复现经验；内容真实性的公共讨论走 practi comment（远端）。
 * 命令面孔对齐 comment：子命令式、-m 带内容、--json 给 agent。
 */

export interface NoteOpts {
  dataDir?: string;
  positional: string[]; // [子命令, hash 或 note id]
  message?: string;
  json: boolean;
}

const USAGE = `usage: practi note add|list|edit|delete
  practi note add <node> -m "<笔记内容>" [--json]
                  把学习/复现笔记钉在节点哈希上（前缀 OK；本地记录，不上传）
  practi note list [hash] [--json]
                  无参=全部笔记（按所属文档分组）；hash=只看该节点子树内的笔记
  practi note edit <note-id> -m "<新内容>" [--json]
  practi note delete <note-id>`;

export function runNote(opts: NoteOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const sub = opts.positional[0];
  switch (sub) {
    case 'add':
      return noteAdd(opts, dataDir);
    case 'list':
      return noteList(opts, dataDir);
    case 'edit':
      return noteEdit(opts, dataDir);
    case 'delete':
      return noteDelete(opts, dataDir);
    default:
      console.error(USAGE);
      return 1;
  }
}

function noteAdd(opts: NoteOpts, dataDir: string): number {
  const target = opts.positional[1];
  if (!target || !opts.message || !opts.message.trim()) {
    console.error('usage: practi note add <node> -m "<笔记内容>"');
    return 1;
  }
  // 存在性校验兼前缀解析：笔记必须钉在工作区已有的节点上（挡手滑哈希）
  const ws = openWorkspace(dataDir);
  const hash = resolveNodeRef(ws, target);
  const file = loadNotes(dataDir);
  const now = new Date().toISOString();
  const note: NoteEntry = { id: newNoteId(), hash, content: opts.message, createdAt: now, updatedAt: now };
  file.notes.push(note);
  saveNotes(dataDir, file);
  if (opts.json) {
    console.log(JSON.stringify(note, null, 2));
    return 0;
  }
  console.log(`noted on ${shortHash(hash)} — id ${note.id}`);
  return 0;
}

function noteList(opts: NoteOpts, dataDir: string): number {
  const target = opts.positional[1];
  const file = loadNotes(dataDir);
  let notes = file.notes;

  if (target) {
    const ws = openWorkspace(dataDir);
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
    const ws2 = openWorkspace(dataDir);
    printNotes(notes, h => ws2.nodes.get(h)?.name ?? shortHash(h));
    return 0;
  }
  // 无参：按所属文档分组（组内时间正序=学习轨迹，组按最新笔记倒序=最近在学的在前）；
  // 钉在已 GC/换根孤儿上的笔记归入悬空组殿后
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);
  const claimed = new Set<string>();
  const groups: { title: string; items: NoteEntry[] }[] = [];
  for (const root of state.direct) {
    if (!ws.nodes.has(root)) continue;
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

function findNote(file: NotesFile, id: string): NoteEntry | null {
  const key = id.toLowerCase();
  const hits = file.notes.filter(n => n.id.startsWith(key));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.error(`error: note id prefix "${id}" matches ${hits.length} notes`);
    return null;
  }
  console.error(`error: note "${id}" not found`);
  return null;
}

function noteEdit(opts: NoteOpts, dataDir: string): number {
  const id = opts.positional[1];
  if (!id || !opts.message || !opts.message.trim()) {
    console.error('usage: practi note edit <note-id> -m "<新内容>"');
    return 1;
  }
  const file = loadNotes(dataDir);
  const note = findNote(file, id);
  if (!note) return 1;
  note.content = opts.message;
  note.updatedAt = new Date().toISOString();
  saveNotes(dataDir, file);
  if (opts.json) {
    console.log(JSON.stringify(note, null, 2));
    return 0;
  }
  console.log(`note ${note.id} edited`);
  return 0;
}

function noteDelete(opts: NoteOpts, dataDir: string): number {
  const id = opts.positional[1];
  if (!id) {
    console.error('usage: practi note delete <note-id>');
    return 1;
  }
  const file = loadNotes(dataDir);
  const note = findNote(file, id);
  if (!note) return 1;
  file.notes.splice(file.notes.indexOf(note), 1);
  saveNotes(dataDir, file);
  console.log(`note ${note.id} deleted`);
  return 0;
}
