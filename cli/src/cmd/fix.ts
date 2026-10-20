import fs from 'node:fs';
import { parseDocument } from '@arshdelight/pop-sdk';

export interface FixOpts {
  positional: string[];
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

/**
 * practi fix <file.json> [--dry-run]：把 v1 格式文档迁到 POP 2.0（剥 revisions/refines，
 * 重算哈希）。内容寻址下剥字段即换身份——旧哈希继续指向旧内容，fix 产生新哈希并明说。
 * 纯文件工具：修的是你手上的文件，实例历史不受影响。剥掉的修订条目全部打印——
 * 历史语义在仓库层（.practi/chain.json + push 后 hub 提交链），本地文本供人工打捞。
 */
export async function runFix(opts: FixOpts): Promise<number> {
  const file = opts.positional[0];
  if (!file || opts.positional.length > 1) {
    console.error('usage: practi fix <file.json> [--dry-run]');
    console.error('       strip POP 1.x history fields (revisions/refines) so the document parses under POP 2.0');
    return 1;
  }
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
