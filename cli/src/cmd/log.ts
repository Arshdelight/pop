import { resolveRepo } from '../practice.js';
import { shortHash } from '../render.js';

export interface LogOpts {
  dir?: string;
  branch?: string;
  limit?: number;
  json?: boolean;
}

/**
 * practi log [--branch <b>] [--limit N] [--json]：实例提交历史（本地链，tip 在前）。
 * git log 同构——seq 是链内登记序号，短哈希是全球坐标；未推送到 hub 的提交标注
 * (local, unpushed)。历史编辑（history squash/reword/drop/reset）后的链以此为准，
 * push 时与 hub 对账。
 */
export function runLog(opts: LogOpts): number {
  const repo = resolveRepo({ dir: opts.dir, verb: 'log' });
  if (repo === null) return 1;
  const chain = repo.chain;
  const branch = opts.branch ?? chain.current;
  const head = chain.branches[branch] ?? null;

  // 该支的提交：从支头沿 parent 回溯（多支时只显示所在链段）
  const byRoot = new Map(chain.commits.map((c) => [c.root, c]));
  const rows = [];
  const seen = new Set<string>();
  let cur: string | null = head;
  while (cur !== null && !seen.has(cur)) {
    const c = byRoot.get(cur);
    if (!c) break;
    seen.add(cur);
    rows.push(c);
    cur = c.parent;
  }

  if (opts.json === true) {
    console.log(JSON.stringify({
      practice: chain.owner ? `${chain.owner}/${chain.name}` : chain.name,
      branch,
      revisions: rows.map((c) => ({ seq: c.seq, root_hash: c.root, parent_hash: c.parent, message: c.message, pushed: c.pushedAt !== undefined })),
    }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no revisions on ${chain.name}@${branch}`);
    return 0;
  }
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : rows.length;
  for (const c of rows.slice(0, limit)) {
    const unpushed = c.pushedAt === undefined ? '  (local, unpushed)' : '';
    console.log(`v${String(c.seq).padEnd(4)} ${shortHash(c.root)}  ${c.message}${unpushed}`);
  }
  if (rows.length > limit) console.log(`... ${rows.length} more (use --limit)`);
  return 0;
}
