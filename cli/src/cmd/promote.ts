import fs from 'node:fs';
import { exportSubtree, type PNode, type Workspace } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';
import { computeOwnership } from '../ownership.js';
import { findNote, type NoteEntry } from '../notes.js';

export interface PromoteOpts {
  dataDir?: string;
  /** note id（唯一前缀 OK） */
  id: string;
  /** 输出文件；省略则把 JSON 打到 stdout（诊断信息一律走 stderr，便于重定向） */
  out?: string;
}

/**
 * practi note promote <note-id>：把一条笔记回流成**草稿文档**。
 *
 * 解决的是 SKILL.md 现在教的那套人肉搬运：先 pin 笔记，事后手抄进文档再 edit——
 * 中间全靠人，于是真正有价值的经验烂在 notes.json 里。
 *
 * 站位（刻意不做的事）：
 *  - **只产草稿，绝不自动 edit**。内容寻址下编辑即换哈希，是否并入必须由人确认。
 *  - 导出的文档是**所属 direct 根**的整棵树（不是笔记钉的那个节点自己）——这样
 *    `practi edit <root> draft.json` 才能把经验并回它被学到的那个实践里。笔记钉在
 *    间接步骤上时，插入点就是那一步在文档里的位置。
 *  - 钉在已消失版本上的笔记：报 E_NOTE_DANGLING，指出它钉的是哪一版，不猜后继。
 */
export function runNotePromote(opts: PromoteOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const m = findNote(dataDir, opts.id);
  if (!m.ok) {
    if (m.reason === 'not_found') console.error(`error: note "${opts.id}" not found`);
    else console.error(`error: note id prefix "${opts.id}" matches ${m.matches} notes`);
    return 1;
  }
  const note = m.note;
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);

  if (!ws.nodes.has(note.hash)) {
    console.error(`error [E_NOTE_DANGLING]: note ${note.id} is pinned to ${note.hash}, which is no longer in this workspace`);
    console.error('  hint: the note outlived the version it was written on (edit replaces content — the old node is GCed).');
    console.error('        re-pin it to the current version with `practi note add`, or read it via `practi note list`.');
    return 1;
  }

  // 归属：笔记钉的节点可能是 direct 根、也可能是某棵树里的间接步骤
  const own = computeOwnership(ws, state.direct);
  const owners = own.owner.get(note.hash) ?? [];
  const isDirect = own.directSet.has(note.hash);
  const root = isDirect ? note.hash : owners[0] ?? note.hash;
  const rootNode = ws.nodes.get(root)!;

  const doc = exportSubtree(rootNode, ws.nodes);
  // 与 exportSubtree 同序遍历存储树 → 同一个下标路径；据此把笔记插进文档里的对应位置
  const path = isDirect ? [] : findIndexPath(ws, root, note.hash);
  const inserted = path === null ? rootNode : insertDraft(doc, path, note);

  const json = JSON.stringify(doc, null, 2);
  const rootIsDirect = own.directSet.has(root);
  const lines: string[] = [];
  lines.push(`promoted: note ${note.id} → draft document`);
  lines.push(`draft of: ${rootNode.name}  [${rootIsDirect ? 'direct root' : 'stored node'}]  ${shortHash(root)}`);
  if (path === null) {
    lines.push(`inserted: at the root's content — the note's node (${shortHash(note.hash)}) is reachable only through`);
    lines.push('          a flow reference, so it cannot be inlined into this document; merge by hand.');
  } else {
    lines.push(`inserted: ${inserted}  (${shortHash(note.hash)})`);
  }
  // 只给建议，不动手：内容寻址下编辑即换哈希，是否并入必须由人确认
  const target = rootIsDirect
    ? `practi edit ${shortHash(root)} <draft.json> --message "merge note ${note.id}"`
    : `practi new <draft.json>   (this node is not in any direct tree; the draft becomes a new direct POP)`;
  lines.push(`next:     ${target}`);
  lines.push('          review the draft first — editing replaces the content (a new hash), it never edits in place.');

  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, json + '\n', 'utf8');
    for (const l of lines) console.log(l);
    console.log(`written:  ${opts.out}`);
    return 0;
  }
  // 无 --out：JSON 走 stdout（可重定向），人看的信息走 stderr
  for (const l of lines) console.error(l);
  console.log(json);
  return 0;
}

/** 存储树上 root → target 的 children 下标路径（与 exportSubtree 的内联顺序一一对应） */
function findIndexPath(ws: Workspace, root: string, target: string): number[] | null {
  const walk = (hash: string, path: number[]): number[] | null => {
    if (hash === target) return path;
    const n = ws.nodes.get(hash);
    if (n?.type !== 'practice') return null;
    for (let i = 0; i < n.children.length; i++) {
      const child = n.children[i].hash;
      if (!ws.nodes.has(child)) continue; // 缺失子节点只会导出成 { hash } pin，不内联
      const found = walk(child, [...path, i]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(root, []);
}

/** 沿下标路径钻进文档，把笔记作为草稿块追加到该节点的 content 末尾 */
function insertDraft(doc: Record<string, unknown>, path: number[], note: NoteEntry): string {
  let cursor: Record<string, unknown> = doc;
  for (const i of path) {
    const children = cursor.children as Record<string, unknown>[];
    cursor = children[i];
  }
  const before = typeof cursor.content === 'string' ? cursor.content : '';
  cursor.content = `${before.trimEnd() === '' ? '' : `${before.trimEnd()}\n\n`}${draftBlock(note)}`;
  return typeof cursor.name === 'string' ? cursor.name : '?';
}

/** 草稿块：笔记原文逐字保留，前后加可 grep 的标记，提醒人并入后删除 */
function draftBlock(note: NoteEntry): string {
  const when = note.createdAt.slice(0, 10);
  return [
    `<!-- ↓ promote ${note.id}：本地笔记原文（${when} 记于 ${shortHash(note.hash)}）。`,
    '     把它并入上面的正文，然后删掉这一段与下面的内容。 ↓ -->',
    '',
    note.content,
    '',
    `<!-- ↑ /promote ${note.id} ↑ -->`,
  ].join('\n');
}
