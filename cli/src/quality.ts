import { qualityWarnings, type QualityWarning, type Workspace } from '@arshdelight/pop-sdk';
import { shortHash } from './render.js';

/**
 * 打印本次子树的 W_* 提示。
 *
 * 只在**已经登记成功之后**调用：W_* 永远不阻断，调用点本身就是「放行」的证明。
 * 输出刻意走 stderr（stdout 留给 created:/status: 这类可解析的行），并且刻意不叫
 * "warning"——new 用 "warning:" 说的是 E_* 拒收，两者混用会让 agent 把提示当阻断。
 */
export function printQualityHints(ws: Workspace, root: string): number {
  const warnings = qualityWarnings([root], ws.nodes);
  if (warnings.length === 0) return 0;

  // 按节点分组：一个节点的多条提示合起来才是「这一步要补什么」
  const groups = new Map<string, QualityWarning[]>();
  for (const w of warnings) {
    const list = groups.get(w.hash);
    if (list === undefined) groups.set(w.hash, [w]);
    else list.push(w);
  }

  console.error(`\nquality hints — ${warnings.length} on ${groups.size} node(s). W_* never block: this pop IS registered; they are prompts to go back and fill in content.`);
  for (const [hash, list] of groups) {
    const n = ws.nodes.get(hash);
    const tag = n === undefined ? '' : n.type === 'practice' ? `practice·${n.op}` : 'action';
    console.error(`  "${list[0].name}"  [${tag}]  ${shortHash(hash)}`);
    for (const w of list) console.error(`      ${w.code.padEnd(15)} ${w.message}`);
  }
  console.error('  E_* issues refuse a document (stored but not registered); W_* hints never do — pop-spec §6, SKILL.md "Recording quality".');
  return warnings.length;
}
