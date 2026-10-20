import { resolveRepo, saveChain, type Repo } from '../practice.js';
import { shortHash } from '../render.js';

export interface BranchOpts {
  positional: string[];
  from?: string;
  deleteBranch?: string;
  dir?: string;
}

/**
 * practi branch [name] [-d <name>] [--from <hash>]：实例支指针管理（本地链操作）。
 *   branch            列全部分支（* = 当前支——git 同款）
 *   branch <name>     从当前支头建新支
 *   branch -d <name>  删支指针（默认支 main 不可删）
 */
export function runBranch(opts: BranchOpts): number {
  const repo: Repo | null = resolveRepo({ dir: opts.dir, verb: 'branch' });
  if (repo === null) return 1;
  const chain = repo.chain;

  if (opts.deleteBranch) {
    const name = opts.deleteBranch;
    if (name === 'main') {
      console.error('error: the default branch main cannot be deleted');
      return 1;
    }
    if (!(name in chain.branches)) {
      console.error(`error: no branch named "${name}"`);
      return 1;
    }
    delete chain.branches[name];
    if (chain.current === name) {
      chain.current = 'main';
      console.log(`note: deleted the current branch — switched back to main`);
    }
    saveChain(repo);
    console.log(`deleted branch: ${name} (revisions and documents untouched)`);
    return 0;
  }

  const name = opts.positional[0];
  if (name) {
    if (name in chain.branches) {
      console.error(`error: branch "${name}" already exists`);
      return 1;
    }
    // --from 给定则从该修订建支（须是链上已登记的 root）；缺省=当前支头
    let head = chain.branches[chain.current] ?? null;
    if (opts.from !== undefined && opts.from !== '') {
      const from = opts.from.startsWith('sha256:') ? opts.from : `sha256:${opts.from}`;
      if (!chain.commits.some((c) => c.root === from)) {
        console.error(`error: --from ${shortHash(from)} is not a revision on this practice's chain (practi log)`);
        return 1;
      }
      head = from;
    }
    chain.branches[name] = head;
    saveChain(repo);
    console.log(`created branch: ${name} (from ${head ? head.slice(7, 19) : 'empty root'})`);
    console.log(`next: \`practi switch ${name}\` then commit into it`);
    return 0;
  }

  // 列表：* = 当前支（git 同款）
  for (const [b, r] of Object.entries(chain.branches)) {
    const mark = b === chain.current ? '*' : ' ';
    console.log(`${mark} ${b}${r ? `  ${r.slice(7, 19)}` : '  (empty)'}`);
  }
  return 0;
}
