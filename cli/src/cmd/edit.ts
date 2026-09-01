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
import { fetchMine, storeDocumentRemote } from '../client.js';
import { runDelete } from './lifecycle.js';

export interface EditOpts {
  dataDir?: string;
  json?: string;
  file?: string;
  message?: string;
  noRevision?: boolean;
  keep?: boolean;
  remote?: boolean;
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
export async function runEdit(opts: EditOpts): Promise<number> {
  const ref = opts.positional[0];
  let text: string | undefined;
  if (opts.json !== undefined) text = opts.json;
  else if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.positional[1]) text = fs.readFileSync(opts.positional[1], 'utf8');
  else if (!process.stdin.isTTY) text = readStdin();

  if (!ref || text === undefined || text.trim() === '') {
    console.error("usage: practi edit <hash> <file.json> | practi edit <hash> --json '<text>' | practi edit <hash> < file.json");
    console.error('       [--message <text>] [--no-revision] [--keep] [--remote (replace the claim on the hub only)]');
    return 1;
  }

  const dataDir = opts.dataDir ?? defaultDataDir();
  if (opts.remote === true) return remoteEdit(opts, dataDir, ref, text);
  return localEdit(opts, dataDir, ref, text);
}

/** --remote：只有远端——把我对 hash A 的认领换成新文档（hash B）：A 经 /mine 解析
 *  （前缀 OK，兼当「是我的认领」预检）→ 新文档带 revision{from:A} POST 上去（hub 解析
 *  算哈希并认领）→ runDelete 撤掉 A（无人再认领时 hub 硬删旧内容）。本地零写入；
 *  撤 A 失败时 B 已在（两认领并存），明说 practi remove <A> --remote 自愈。 */
async function remoteEdit(opts: EditOpts, dataDir: string, ref: string, text: string): Promise<number> {
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }

  let oldRoot: string;
  try {
    const mine = await fetchMine(dataDir, state.remote.url);
    const hits = mine.filter((r) => r.root_hash === ref || r.root_hash.startsWith(`sha256:${ref.replace(/^sha256:/, '')}`));
    if (hits.length === 0) {
      console.error(`error: ${ref} is not one of your remote claims — remote edit replaces YOUR claim;`);
      console.error('       list them with `practi pull`-visible roots or check the hub (search --scope me)');
      return 1;
    }
    if (hits.length > 1) {
      console.error(`error: hash prefix "${ref}" matches ${hits.length} of your remote claims — give more hex`);
      return 1;
    }
    oldRoot = hits[0].root_hash;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
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
        what: opts.message ?? 'edited via practi edit --remote',
        from: oldRoot,
      });
      doc.revisions = revisions;
    }
  }

  let newRoot: string;
  try {
    const stored = await storeDocumentRemote(dataDir, state.remote.url, doc);
    newRoot = stored.rootHash;
    console.log(`edited:   ${oldRoot} -> ${newRoot}  (on the hub — it parsed and hashed the tree)`);
  } catch (e) {
    console.error(`error: remote edit failed — ${(e as Error).message} (the old claim is untouched)`);
    return 1;
  }

  const code = await runDelete({ dataDir, positional: [oldRoot] });
  if (code !== 0) {
    console.error(`remote:   withdrawing the old claim failed — both versions are claimed on the hub now; run \`practi remove ${oldRoot} --remote\` to finish`);
    return 1;
  }
  return 0;
}

function localEdit(opts: EditOpts, dataDir: string, ref: string, text: string): number {
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
