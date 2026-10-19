import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  computeNodeHash,
  nodeFilePath,
  parseDocument,
  parseNodeFromMatter,
  saveNode,
  type PNode,
} from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { shortHash } from '../render.js';

export interface FixOpts {
  dataDir?: string;
  positional: string[];
  all?: boolean;
  dryRun?: boolean;
}

/** POP 2.0 移除的字段（历史归仓库层，spec §9.1）——fix 的剥除对象 */
const LEGACY_FIELDS = ['revisions', 'refines'] as const;

interface Removed {
  path: string;
  field: string;
  value: unknown;
}

/**
 * 按协议结构剥除 legacy 字段：只走节点层级（顶层 + children 内联节点），
 * 绝不深入 metadata/attachments/inputs/outputs——用户数据里同名键不是协议字段。
 * 每个剥掉的东西都登记进 removed，不静默丢数据。
 */
function stripLegacy(node: Record<string, unknown>, nodePath: string, removed: Removed[]): void {
  for (const field of LEGACY_FIELDS) {
    if (node[field] !== undefined) {
      removed.push({ path: nodePath, field, value: node[field] });
      delete node[field];
    }
  }
  const children = node.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      // 只有内联节点继续递归；{ hash } ChildRef 是引用不是节点
      if (typeof c === 'object' && c !== null && !Array.isArray(c) && !('hash' in (c as Record<string, unknown>))) {
        stripLegacy(c as Record<string, unknown>, `${nodePath}.children[${i}]`, removed);
      }
    }
  }
}

function printRemoved(removed: Removed[]): void {
  for (const r of removed) {
    console.log(`  removed ${r.path}.${r.field} = ${JSON.stringify(r.value)}`);
  }
}

function usage(): void {
  console.error('usage: practi fix <file.json> | practi fix <hash> | practi fix --all   [--dry-run]');
  console.error('       strip POP 1.x history fields (revisions/refines) so the document parses under POP 2.0');
}

/**
 * practi fix：把 v1 格式文档迁到 POP 2.0（剥 revisions/refines，重算哈希）。
 * 内容寻址下剥字段即换身份——旧哈希继续指向旧内容，fix 产生新哈希并明说。
 * - <file.json>  原地修一个文档文件（parseDocument 重验，覆写）
 * - <hash>       修工作区节点（frontmatter 剥除 → 新节点文件 → practi.json direct/claims 换绑，
 *                认领时间戳保留；旧节点文件留待 GC）
 * - --all        扫全部 direct，文本探测含 legacy 字段的节点逐个修
 * 剥掉的修订条目全部打印——历史语义挪去仓库层（push 后 hub 提交链），本地文本供人工打捞。
 */
export async function runFix(opts: FixOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const target = opts.positional[0];
  if (!opts.all && !target) {
    usage();
    return 1;
  }

  if (opts.all) {
    return fixAll(opts, dataDir);
  }
  // hex 形态（含前缀/短前缀）一律走工作区模式；文件模式收其余一切路径
  if (/^(sha256:)?[0-9a-f]{4,64}$/i.test(target)) {
    return fixNode(opts, dataDir, target);
  }
  return fixFile(opts, target);
}

/* ── 文件模式：原地修一个 JSON 文档 ── */

function fixFile(opts: FixOpts, file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`error: cannot read ${file} — ${(e as Error).message}`);
    return 1;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    console.error(`error [E_JSON]: ${file} is not valid JSON — ${(e as Error).message}`);
    return 1;
  }
  const removed: Removed[] = [];
  stripLegacy(doc, '$', removed);
  if (removed.length === 0) {
    console.log(`nothing to fix: ${file} carries no v1 history fields`);
    return 0;
  }
  // 剥完必须能过 2.0 解析；过不了说明还有别的问题，不覆写
  try {
    const parsed = parseDocument(doc);
    if (opts.dryRun === true) {
      console.log(`dry-run: would rewrite ${file} (stripping ${removed.length} legacy field(s), new root ${parsed.rootHash}):`);
      printRemoved(removed);
      return 0;
    }
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    console.log(`fixed:    ${file} (stripped ${removed.length} legacy field(s), new root ${parsed.rootHash}):`);
    printRemoved(removed);
    return 0;
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    console.error(`error [${err.code ?? 'E_PARSE'}]: ${file} still fails validation after stripping — nothing written`);
    console.error(`  ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}`);
    return 1;
  }
}

/* ── 工作区模式：修一个已存节点 ── */

/**
 * 按文件名解析节点引用（全形/前缀）。刻意不走 workspace map：v1 存量节点在
 * 2.0 解析下 E_SCHEMA、loadWorkspace 进不了 map——fix 面对的恰恰是这批文件。
 * 前缀唯一才解析；0 或多个命中返回 null。
 */
function resolveStoredRef(dataDir: string, ref: string): string | null {
  const norm = ref.replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(norm)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(path.join(dataDir, 'nodes'));
  } catch {
    return null;
  }
  const hits = files.filter((f) => f.endsWith('.md') && f.slice(0, -'.md'.length).startsWith(norm));
  return hits.length === 1 ? `sha256:${hits[0].slice(0, -'.md'.length)}` : null;
}

function fixNode(opts: FixOpts, dataDir: string, ref: string): number {
  const hash = resolveStoredRef(dataDir, ref);
  if (hash === null) {
    console.error(`error: no stored node matches "${ref}" (unique hash prefix required)`);
    return 1;
  }
  const file = nodeFilePath(dataDir, hash);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`error: node file missing for ${hash} — nothing to fix (workspace inconsistency; see \`practi ls\`)`);
    return 1;
  }
  const parsed = matter(raw);
  const removed: Removed[] = [];
  for (const field of LEGACY_FIELDS) {
    if (parsed.data[field] !== undefined) {
      removed.push({ path: hash, field, value: parsed.data[field] });
      delete parsed.data[field];
    }
  }
  if (removed.length === 0) {
    console.log(`nothing to fix: ${shortHash(hash)} carries no v1 history fields`);
    return 0;
  }
  // 剥完必须能按 2.0 解析且哈希自洽，才落新文件
  let node: PNode;
  try {
    node = parseNodeFromMatter(parsed.data, parsed.content, parsed.matter);
    const recomputed = computeNodeHash(node);
    if (opts.dryRun === true) {
      console.log(`dry-run: would re-store ${hash} as ${recomputed} (stripping ${removed.length} legacy field(s)):`);
      printRemoved(removed);
      return 0;
    }
    const newHash = saveNode(dataDir, node);
    const state = loadState(dataDir);
    if (state.direct.includes(hash)) {
      state.direct = state.direct.map((h) => (h === hash ? newHash : h));
      // 认领时间戳保留：fix 是迁移不是重新注册
      const stamped = state.claims?.[hash];
      if (stamped !== undefined) {
        delete state.claims![hash];
        state.claims![newHash] = stamped;
      }
      saveState(dataDir, state);
    }
    console.log(`fixed:    ${hash} -> ${newHash}  (stripped ${removed.length} legacy field(s); old node file kept for GC):`);
    printRemoved(removed);
    return 0;
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    console.error(`error [${err.code ?? 'E_PARSE'}]: ${shortHash(hash)} still fails validation after stripping — nothing written`);
    console.error(`  ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}`);
    return 1;
  }
}

/* ── --all：扫全部 direct ── */

function fixAll(opts: FixOpts, dataDir: string): number {
  const state = loadState(dataDir);
  if (state.direct.length === 0) {
    console.log('no direct pops registered — nothing to fix');
    return 0;
  }
  let dirty = 0;
  let missing = 0;
  for (const hash of state.direct) {
    const file = nodeFilePath(dataDir, hash);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      missing++;
      continue;
    }
    const fmText = raw.split('---')[1] ?? '';
    const hasLegacy = LEGACY_FIELDS.some((f) => fmText.split('\n').some((l) => l.startsWith(`${f}:`)));
    if (!hasLegacy) continue;
    dirty++;
    if (opts.dryRun === true) {
      console.log(`dry-run: ${hash} carries v1 history fields (fix <hash> to strip)`);
      continue;
    }
    const code = fixNode({ ...opts, positional: [hash] }, dataDir, hash);
    if (code !== 0) return code;
  }
  if (missing > 0) console.log(`note:     ${missing} direct root(s) have no node file on disk — skipped (pre-existing gaps, see \`practi ls\`)`);
  if (dirty === 0) console.log(`nothing to fix: ${state.direct.length} direct pop(s) scanned, none carries v1 history fields`);
  else if (opts.dryRun === true) console.log(`dry-run summary: ${dirty} of ${state.direct.length} direct pop(s) would be fixed`);
  else console.log(`fix --all done: ${dirty} of ${state.direct.length} direct pop(s) migrated to POP 2.0`);
  return 0;
}
