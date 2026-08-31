import { defaultDataDir, loadState, saveState } from '../state.js';
import { nodeFileTime, openWorkspace } from '../workspace.js';

export interface RepairOpts {
  dataDir?: string;
}

/** 幂等补戳：给没有 claims 的 direct 根按节点文件 mtime 回填认领时刻。
 *  已有戳的一律不动（重跑零副作用）；节点文件缺失的警告跳过并记为失败。
 *  mtime 语义=内容落进本工作区的时刻（new/edit=创建或编辑；clone/pull=拉取），
 *  是老数据（claims 表出现前认领的）能拿到的最接近证据。 */
export function runRepair(opts: RepairOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);

  let already = 0;
  let backfilled = 0;
  const unrepairable: string[] = [];
  for (const h of state.direct) {
    if (state.claims?.[h]) {
      already++;
      continue;
    }
    const t = nodeFileTime(dataDir, h);
    if (t === null || !ws.nodes.has(h)) {
      unrepairable.push(h);
      continue;
    }
    (state.claims ??= {})[h] = t;
    backfilled++;
  }
  if (backfilled > 0) saveState(dataDir, state);

  console.log(`claims:   ${already} already stamped, ${backfilled} backfilled from file time, ${unrepairable.length} unrepairable`);
  for (const h of unrepairable) console.log(`  no local node file: ${h}`);
  return unrepairable.length > 0 ? 1 : 0;
}
