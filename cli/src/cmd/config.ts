import path from 'node:path';
import { dataDirResolution, loadState, pointerPath } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { loadCredentials, existingAuthFile, authPath } from '../credentials.js';
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
  let ws;
  try {
    ws = openWorkspace(dataDir);
  } catch {
    ws = null;
  }
  const direct = ws ? state.direct.filter((h) => ws.nodes.has(h)).length : state.direct.length;
  const indirect = ws ? ws.nodes.size - direct : 0;
  const creds = loadCredentials(dataDir);
  console.log(`practi:    ${CLI_VERSION}   pop-spec: ${POP_SPEC_VERSION}`);
  console.log(`data dir:   ${dataDir}  (via ${via})`);
  console.log(`remote:     ${state.remote ? state.remote.url : '(not set)'}`);
  console.log(`auth:       ${creds ? `logged in as ${creds.client_name ?? 'practi cli'} (${existingAuthFile(dataDir) ?? authPath(dataDir)})` : '(not logged in)'}`);
  console.log(`direct:     ${direct}`);
  console.log(`indirect:   ${indirect}`);
  if (ws && ws.parseIssues.length > 0) {
    console.log(`warnings:   ${ws.parseIssues.length} parse issue(s) — run \`practi ls\` to see them`);
  }
  return 0;
}
