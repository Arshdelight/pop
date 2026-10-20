import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, loadState, saveState } from '../state.js';

export interface InitOpts {
  dataDir?: string;
  positional: string[];
}

/** 初始化配置家（幂等）：只放凭据与 remote——实践本体是散布各处的普通文件夹，
 *  家里没有 workspace 标记也没有节点池。login/remote set 会隐式建家；init 显式建。 */
export function runInit(opts: InitOpts): number {
  const target = opts.positional[0] ? path.resolve(opts.positional[0]) : opts.dataDir ?? defaultDataDir();
  fs.mkdirSync(target, { recursive: true });
  const existed = fs.existsSync(path.join(target, 'practi.json'));
  if (!existed) {
    saveState(target, loadState(target));
  }
  console.log(`${existed ? 'already initialized' : 'initialized'}: ${target}  (config home — credentials + remote)`);
  return 0;
}
