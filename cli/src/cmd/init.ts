import path from 'node:path';
import { defaultDataDir } from '../state.js';
import { initDataDir } from '../workspace.js';

export interface InitOpts {
  dataDir?: string;
  positional: string[];
}

export function runInit(opts: InitOpts): number {
  const target = opts.positional[0] ? path.resolve(opts.positional[0]) : opts.dataDir ?? defaultDataDir();
  const result = initDataDir(target);
  console.log(result === 'exists' ? `already initialized: ${target}` : `initialized: ${target}`);
  console.log(`use --data-dir <path> on other commands to target this directory`);
  return 0;
}
