import { defaultDataDir } from '../state.js';
import { resolvePractice, saveChain } from '../practice.js';

export interface SwitchOpts {
  dataDir?: string;
  positional: string[];
  dir?: string;
  practice?: string;
}

/** practi switch <branch>：切当前支（本地指针；历史内容照旧在链上，publish 落到新支） */
export function runSwitch(opts: SwitchOpts): number {
  const name = opts.positional[0];
  if (!name) {
    console.error('usage: practi switch <branch>');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const repo = resolvePractice({ dataDir, explicitDir: opts.dir, explicitName: opts.practice, verb: 'switch' });
  if (repo === null) return 1;
  if (!(name in repo.chain.branches)) {
    console.error(`error: no branch named "${name}" — \`practi branch ${name}\` to create it`);
    return 1;
  }
  repo.chain.current = name;
  saveChain(repo);
  const head = repo.chain.branches[name];
  console.log(`switched to branch: ${name} (on ${repo.chain.owner ? `${repo.chain.owner}/` : ''}${repo.chain.name})`);
  console.log(`head:    ${head ? head.slice(7, 19) : '(empty)'}`);
  return 0;
}
