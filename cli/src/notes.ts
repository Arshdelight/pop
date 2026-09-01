import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '@arshdelight/pop-sdk';

/**
 * 学习笔记（本地 sidecar，不进协议、不上 hub）：notes.json，扁平数组，每条钉在一个
 * 节点哈希上。设计站位与 state.claims 相同——时间与个人痕迹不属于内容寻址的节点本体，
 * 属于「人对这一版内容的经验」，侧挂存储。内容寻址白送的语义：笔记永远指向这一版
 * 内容，不会有「笔记跟着编辑漂移」的问题（edit 换根后旧笔记成为孤儿，保留不删）。
 * 与远端 comment 的分工：note=个人学习/复现经验（本地），comment=内容真实性（公共）。
 */
export const NOTES_FILE = 'notes.json';

export interface NoteEntry {
  /** 短随机 id（8 hex）；edit/delete 接受唯一前缀 */
  id: string;
  /** 钉住的节点（一律存全形 sha256:<64hex>） */
  hash: string;
  /** 纯文本，随便怎么记（不解析结构） */
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotesFile {
  schema: 1;
  notes: NoteEntry[];
}

export function notesPath(dataDir: string): string {
  return path.join(dataDir, NOTES_FILE);
}

export function newNoteId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/** 接受 sha256:<64hex> 或裸 64hex，归一成全形；其余（含短前缀）返回 null——
 *  存储层只认全形，前缀解析是命令层的职责（那里有工作区可查） */
export function normalizeHash(ref: string): string | null {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 读取并消毒：文件缺失/损坏/条目坏一律降级（与 loadState 同一口径），逐条过滤不致命 */
export function loadNotes(dataDir: string): NotesFile {
  const empty: NotesFile = { schema: 1, notes: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(notesPath(dataDir), 'utf8');
  } catch {
    return empty;
  }
  try {
    const rec = asRecord(JSON.parse(raw));
    if (rec === null || !Array.isArray(rec.notes)) return empty;
    const notes: NoteEntry[] = [];
    for (const item of rec.notes) {
      const r = asRecord(item);
      if (!r) continue;
      const id = r.id;
      const hash = r.hash;
      const content = r.content;
      const createdAt = r.createdAt;
      const updatedAt = r.updatedAt;
      if (
        typeof id !== 'string' || !/^[0-9a-f]{4,32}$/.test(id) ||
        typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash) ||
        typeof content !== 'string' ||
        typeof createdAt !== 'string' || typeof updatedAt !== 'string'
      ) continue;
      notes.push({ id, hash, content, createdAt, updatedAt });
    }
    return { schema: 1, notes };
  } catch {
    return empty;
  }
}

export function saveNotes(dataDir: string, file: NotesFile): void {
  fs.writeFileSync(notesPath(dataDir), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 子树哈希集（含根自身）：note list 按文档/子树过滤用。直接走 nodes 图的 children pin，
 *  不经 exportSubtree 的 JSON 化。防环靠集合本身（内容寻址树天然无环，守一下不亏） */
export function subtreeHashes(ws: Workspace, root: string): Set<string> {
  const set = new Set<string>();
  const visit = (h: string): void => {
    if (set.has(h)) return;
    set.add(h);
    const n = ws.nodes.get(h);
    if (n?.type !== 'practice') return;
    for (const c of n.children) visit(c.hash);
  };
  visit(root);
  return set;
}
