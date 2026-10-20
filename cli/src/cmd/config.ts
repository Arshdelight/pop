import path from 'node:path';
import { dataDirResolution, loadState, pointerPath } from '../state.js';
import { CLI_VERSION, POP_SPEC_VERSION } from '../version.js';

export interface ConfigOpts {
  dataDir?: string;
}

/** Resolution transparency: config always answers "why this directory" —
 *  explicit --data-dir, session env, persisted pointer, or convention. */
function describeDataDir(explicit?: string): { dir: string; via: string } {
  if (explicit) return { dir: path.resolve(explicit), via: '--data-dir' };
  const r = dataDirResolution();
  const via =
    r.via === 'env'
      ? process.env.PRACTI_HOME
        ? '$PRACTI_HOME'
        : '$POP_HOME'
      : r.via === 'pointer'
        ? `pointer ${pointerPath()}`
        : 'convention';
  return { dir: r.dir, via };
}

export function runConfig(opts: ConfigOpts): number {
  const { dir: dataDir, via } = describeDataDir(opts.dataDir);
  const state = loadState(dataDir);
  console.log(`practi:    ${CLI_VERSION}   pop-spec: ${POP_SPEC_VERSION}`);
  console.log(`config home: ${dataDir}  (via ${via})  — credentials + remote; practice folders live anywhere`);
  console.log(`remote:     ${state.remote?.url ?? '(not configured — `practi remote set <url>`)'}`);
  return 0;
}
