import { defaultDataDir } from '../state.js';
import { resolvePractice, saveChain } from '../practice.js';
import { shortHash } from '../render.js';

export interface MergeOpts {
  dataDir?: string;
  positional: string[];
  dir?: string;
  practice?: string;
}

/**
 * practi merge <branch>：把指定支合并进当前支（本地链操作，合并方向=参数支 → 当前支）。
 * 两种结局，按本地提交链 parent 可达性决定：
 * - fast-forward：参数支头沿 parent 链可达当前支头 → 纯移指针，零新提交；
 * - 分叉（squash）：不可达 → 追加一条提交（内容=参数支头的树，父=当前支头），
 *   合并永远可完成；等价 git 的 squash merge。push 时与 hub 对账。
 */
export function runMerge(opts: MergeOpts): number {
  const fromBranch = opts.positional[0];
  if (!fromBranch) {
    console.error('usage: practi merge <branch>');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const repo = resolvePractice({ dataDir, explicitDir: opts.dir, explicitName: opts.practice, verb: 'merge' });
  if (repo === null) return 1;
  const chain = repo.chain;
  if (fromBranch === chain.current) {
    console.error(`error: cannot merge ${fromBranch} into itself`);
    return 1;
  }
  const fromTip = chain.branches[fromBranch] ?? null;
  const intoTip = chain.branches[chain.current] ?? null;
  if (!fromTip) {
    console.error(`error: branch ${fromBranch} has no revisions to merge`);
    return 1;
  }
  if (fromTip === intoTip) {
    console.log('already up to date');
    return 0;
  }

  // 快进判定：from 头沿 parent 链能走到 into 头（into 为空=天然快进）
  const reaches = (from: string, target: string | null): boolean => {
    if (target === null) return true;
    const byRoot = new Map(chain.commits.map((c) => [c.root, c]));
    const seen = new Set<string>();
    let cur: string | null = from;
    while (cur !== null && !seen.has(cur)) {
      if (cur === target) return true;
      seen.add(cur);
      cur = byRoot.get(cur)?.parent ?? null;
    }
    return false;
  };

  if (reaches(fromTip, intoTip)) {
    chain.branches[chain.current] = fromTip;
    saveChain(repo);
    console.log(`fast-forward: ${chain.current} → ${shortHash(fromTip)} (merged ${fromBranch})`);
    return 0;
  }

  // 分叉：POP 内容寻址下「同 root 恰一行」（spec §9.1）——同树的提交是同一个提交，
  // 无法带第二个 parent，所以分叉合并同样是把当前支指针移到参数支头（旧 hub 实现的
  // 「回绑」同效果）。链不变，push 时与 hub 对账。
  chain.branches[chain.current] = fromTip;
  saveChain(repo);
  console.log(`merged:  ${fromBranch} → ${chain.current}  ${shortHash(fromTip)}  (pointer move — same-tree commits are identical)`);
  console.log('note:    the chain diverged from the hub if pushed — `practi push --force` to sync');
  return 0;
}
