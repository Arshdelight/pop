import { dirtyGuardMessage, isDirty, resolveRepo, saveChain, writeWorkingFile, type Repo } from '../practice.js';

export interface SwitchOpts {
  positional: string[];
  dir?: string;
}

/** practi switch <branch>：切当前支（本地指针）；工作文件回写成新支头（git checkout 语义），
 *  有未提交改动时拒切——先 commit。 */
export function runSwitch(opts: SwitchOpts): number {
  const name = opts.positional[0];
  if (!name) {
    console.error('usage: practi switch <branch>');
    return 1;
  }
  const repo: Repo | null = resolveRepo({ dir: opts.dir, verb: 'switch' });
  if (repo === null) return 1;
  if (!(name in repo.chain.branches)) {
    console.error(`error: no branch named "${name}" — \`practi branch ${name}\` to create it`);
    return 1;
  }
  if (name !== repo.chain.current && isDirty(repo)) {
    console.error(`error: ${dirtyGuardMessage(repo)}`);
    return 1;
  }
  repo.chain.current = name;
  saveChain(repo);
  const head = repo.chain.branches[name];
  if (head !== null) writeWorkingFile(repo, head);
  console.log(`switched to branch: ${name} (on ${repo.chain.owner ? `${repo.chain.owner}/` : ''}${repo.chain.name})`);
  console.log(`head:    ${head ? head.slice(7, 19) : '(empty)'}  (working file updated)`);
  return 0;
}
