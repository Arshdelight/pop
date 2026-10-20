import { qualityWarnings, type QualityWarning } from '@arshdelight/pop-sdk';
import { openPool, chainHead, resolveRepo } from '../practice.js';
import { shortHash } from '../render.js';

export interface LintOpts {
  dir?: string;
  json: boolean;
  /** 人类输出里最多列几个节点（按提示数降序） */
  limit?: number;
}

/**
 * practi lint —— 当前实例当前支头的记录质量审计。
 *
 * `W_*` 原本只在创建内容的那一刻出现一次，于是历史提示会静静积在语料里：
 * 你知道「当时该补点什么」，但没有任何命令能把这些欠账列出来。lint 就是那道门：
 * 复用同一份 `qualityWarnings`（口径与创建时完全一致，不另立标准），审当前支的头文档。
 *
 * 纯读、不阻断：退出码恒为 0，它不是门禁，是清单。
 */
export function runLint(opts: LintOpts): number {
  const repo = resolveRepo({ dir: opts.dir, verb: 'lint' });
  if (repo === null) return 1;
  const ws = openPool(repo);
  const head = chainHead(repo.chain);
  if (head === null) {
    console.log(`(empty) ${repo.chain.name}@${repo.chain.current}`);
    return 0;
  }
  const warnings = qualityWarnings([head], ws.nodes);

  if (opts.json) {
    console.log(JSON.stringify({
      head,
      practice: repo.chain.owner ? `${repo.chain.owner}/${repo.chain.name}` : repo.chain.name,
      branch: repo.chain.current,
      nodes: ws.nodes.size,
      total: warnings.length,
      byCode: summarise(warnings),
      items: warnings,
    }, null, 2));
    return 0;
  }

  if (warnings.length === 0) {
    console.log(`lint: clean — ${repo.chain.name}@${repo.chain.current} (${ws.nodes.size} node(s) in the pool), no W_* hints`);
    return 0;
  }

  // 按节点归组：一个节点的多条提示合起来才是「这一步要补什么」
  const groups = new Map<string, QualityWarning[]>();
  for (const w of warnings) {
    const list = groups.get(w.hash);
    if (list === undefined) groups.set(w.hash, [w]);
    else list.push(w);
  }
  const ranked = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1));

  console.log(`lint: ${warnings.length} hint(s) on ${groups.size} of ${ws.nodes.size} node(s), across ${repo.chain.name}@${repo.chain.current}`);
  console.log('\nby code:');
  for (const s of summarise(warnings)) {
    console.log(`  ${s.code.padEnd(15)} ${String(s.count).padStart(4)}  ${s.message}`);
  }
  const limit = opts.limit ?? 20;
  console.log(`\nnodes (worst ${Math.min(limit, ranked.length)} of ${ranked.length}):`);
  for (const [hash, list] of ranked.slice(0, limit)) {
    const n = ws.nodes.get(hash)!;
    const tag = n.type === 'practice' ? `practice·${n.op}` : 'action';
    console.log(`  "${list[0].name}"  [${tag}]  ${shortHash(hash)}`);
    for (const w of list) console.log(`      ${w.code.padEnd(15)} ${w.message}`);
  }
  console.log('\nhint: these never block anything. Fix them with `practi show <hash> --doc` → edit the working file → `practi commit -m "..."`.');
  return 0;
}

/** 按码聚合，并带上该类提示的「说明」（取第一条的 message 去掉具体数字前的那截） */
function summarise(warnings: readonly QualityWarning[]): { code: string; count: number; message: string }[] {
  const byCode = new Map<string, { count: number; message: string }>();
  for (const w of warnings) {
    const cur = byCode.get(w.code);
    if (cur === undefined) byCode.set(w.code, { count: 1, message: w.message });
    else cur.count++;
  }
  return [...byCode.entries()]
    .map(([code, v]) => ({ code, count: v.count, message: v.message }))
    .sort((a, b) => (b.count - a.count) || (a.code < b.code ? -1 : 1));
}
