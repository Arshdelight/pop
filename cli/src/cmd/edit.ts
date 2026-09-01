import fs from 'node:fs';
import {
  createFromDoc,
  loadWorkspace,
  validateWorkspace,
  resolveNodeRef,
  nodeFilePath,
  type Workspace,
} from '@arshdelight/pop-sdk';
import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';

export interface EditOpts {
  dataDir?: string;
  json?: string;
  file?: string;
  message?: string;
  noRevision?: boolean;
  keep?: boolean;
  positional: string[];
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function short(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 10);
}

/**
 * 从全部 direct 根做可达性分析（沿 children pins 走——内联与 ChildRef 同形存储，无需区分），
 * 返回工作区里不可达的节点哈希。即 hub reconcileIndirectClaims 的本地对应：
 * 引用计数（被几个 direct 根的后代集合包含）归 0 才清除。
 */
export function collectUnreachable(ws: Workspace, directRoots: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...directRoots];
  while (stack.length > 0) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    const node = ws.nodes.get(h);
    if (!node) continue;
    seen.add(h);
    if (node.type === 'practice') {
      for (const c of node.children) stack.push(c.hash);
    }
  }
  return [...ws.nodes.keys()].filter((h) => !seen.has(h));
}

/**
 * practi edit <hash>：非交互编辑一个 direct 根——新文档（file/--json/stdin）→ 新哈希换注册。
 * 编辑即修订：根节点自动追加 revisions（from = 旧根哈希；spec §2.2 历史指针，允许悬空、永不校验）。
 * 默认 GC 不可达节点（旧根及其独有后代；仍被其它 direct 根引用的内容保留）；--keep 跳过。
 * 纯本地操作：远端旧版仍在，结束时提示 push + delete 同步。
 */
export function runEdit(opts: EditOpts): number {
  const ref = opts.positional[0];
  let text: string | undefined;
  if (opts.json !== undefined) text = opts.json;
  else if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.positional[1]) text = fs.readFileSync(opts.positional[1], 'utf8');
  else if (!process.stdin.isTTY) text = readStdin();

  if (!ref || text === undefined || text.trim() === '') {
    console.error("usage: practi edit <hash> <file.json> | practi edit <hash> --json '<text>' | practi edit <hash> < file.json");
    console.error('       [--message <text>] [--no-revision] [--keep]');
    return 1;
  }

  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const ws = openWorkspace(dataDir);
  const oldRoot = resolveNodeRef(ws, ref);
  if (!state.direct.includes(oldRoot)) {
    console.error(`error: ${oldRoot} is not one of your direct pops — edit swaps a direct root;`);
    console.error('       for anything else fork it instead (practi show <hash> --doc, change, practi new)');
    return 1;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`error [E_JSON]: not valid JSON — ${(e as Error).message}`);
    return 1;
  }
  if (!isRecord(doc)) {
    console.error('error [E_SCHEMA]: the document must be a JSON object (one tree, root included)');
    return 1;
  }

  if (opts.noRevision !== true) {
    const revisions = Array.isArray(doc.revisions) ? (doc.revisions as unknown[]) : [];
    const already = revisions.some((r) => isRecord(r) && r.from === oldRoot);
    if (!already) {
      revisions.push({
        when: new Date().toISOString().slice(0, 10),
        what: opts.message ?? 'edited via practi edit',
        from: oldRoot,
      });
      doc.revisions = revisions;
    }
  }

  const { root: newRoot, count } = createFromDoc(ws, doc);
  const issues = validateWorkspace(loadWorkspace(dataDir));
  if (issues.length > 0) {
    for (const i of issues) {
      console.error(`  ${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
    }
    console.error(`warning:  new tree stored (hash ${newRoot}) but NOT swapped in — ${issues.length} validation issue(s); old pop untouched`);
    return 1;
  }

  if (newRoot === oldRoot) {
    console.log(`unchanged: ${oldRoot} (content hashes identically, nothing to swap)`);
    return 0;
  }

  state.direct = state.direct.filter((h) => h !== oldRoot);
  claimDirect(state, newRoot);
  saveState(dataDir, state);
  console.log(`edited:   ${oldRoot} -> ${newRoot}  (${count} nodes)`);

  if (opts.keep === true) {
    console.log('gc:       skipped (--keep) — old nodes kept on disk');
  } else {
    const dead = collectUnreachable(loadWorkspace(dataDir), state.direct);
    for (const h of dead) fs.unlinkSync(nodeFilePath(dataDir, h));
    console.log(
      `gc:       removed ${dead.length} unreachable node(s)${dead.length > 0 ? ` — ${dead.map(short).join(', ')}` : ''}`
    );
  }
  console.log(`remote:   the hub still holds the old version — sync with \`practi push\` then \`practi remove ${oldRoot} --remote\``);
  return 0;
}
