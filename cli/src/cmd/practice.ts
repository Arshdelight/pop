import path from 'node:path';
import { defaultDataDir } from '../state.js';
import { createPractice, listRegistryPractices, removeRegistryPractice } from '../practice.js';
import { shortHash } from '../render.js';

export interface PracticeOpts {
  dataDir?: string;
  positional: string[];
  /** 在指定目录建独立实例仓库（目录即仓库，自带节点池） */
  dir?: string;
}

/**
 * practi practice — 实例子命令（practice 管理器）：
 *   practice new <name>      新建实例（默认工作目录账本登记；--dir <path>=在指定目录
 *                            建独立实例仓库）。实例在本地诞生，首次 push 才在 hub 诞生
 *   practice list            列工作目录里的实例（registry 式）
 *   practice remove <name>   删本地实例登记（hub 不动；同 git 删本地 clone）
 */
export function runPractice(opts: PracticeOpts): number {
  const action = opts.positional[0];
  const dataDir = opts.dataDir ?? defaultDataDir();

  if (action === 'new') {
    const name = opts.positional[1];
    if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) {
      console.error('usage: practi practice new <name> [--dir <path>]   (name: letters/digits/dash)');
      return 1;
    }
    const dir = opts.dir ? path.resolve(opts.dir) : undefined;
    const repo = createPractice(dataDir, name, dir);
    console.log(`created practice: ${name}${dir ? `  (${repo.dataDir})` : '  (in the workspace)'}`);
    console.log('next:  `practi publish <pop> --to ' + name + '` to add its first revision, or `practi publish <pop>` inside it');
    return 0;
  }

  if (action === 'list' || action === undefined) {
    const practices = listRegistryPractices(dataDir);
    if (practices.length === 0) {
      console.log('no practices in the workspace — `practi practice new <name>` or `practi clone <owner>/<name>`');
      return 0;
    }
    for (const repo of practices) {
      const head = repo.chain.branches[repo.chain.current];
      const where = repo.chain.owner ? `${repo.chain.owner}/${repo.chain.name}` : `(local only)`;
      console.log(
        `${repo.chain.name.padEnd(24)} ${repo.chain.current.padEnd(12)} ${head ? shortHash(head) : '(empty)'}  ${where}`
      );
    }
    return 0;
  }

  if (action === 'remove') {
    const name = opts.positional[1];
    if (!name) {
      console.error('usage: practi practice remove <name>   (removes the LOCAL registration; the hub is untouched)');
      return 1;
    }
    if (removeRegistryPractice(dataDir, name)) {
      console.log(`removed practice: ${name}  (local only — the hub, if it has one, is untouched)`);
      return 0;
    }
    console.error(`error: no practice named "${name}" in the workspace`);
    return 1;
  }

  console.error('usage: practi practice new <name> [--dir <path>] | list | remove <name>');
  return 1;
}
