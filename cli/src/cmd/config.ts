import path from 'node:path';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { loadCredentials, authPath } from '../credentials.js';

export interface ConfigOpts {
  dataDir?: string;
}

export function runConfig(opts: ConfigOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  let ws;
  try {
    ws = openWorkspace(dataDir);
  } catch {
    ws = null;
  }
  const direct = state.direct.length;
  const indirect = ws ? ws.nodes.size - direct : 0;
  const creds = loadCredentials(dataDir);
  console.log(`data dir:   ${path.resolve(dataDir)}`);
  console.log(`remote:     ${state.remote ? state.remote.url : '(not set)'}`);
  console.log(`auth:       ${creds ? `logged in as ${creds.client_name ?? 'pop cli'} (${authPath(dataDir)})` : '(not logged in)'}`);
  console.log(`direct:     ${direct}`);
  console.log(`indirect:   ${indirect}`);
  if (ws && ws.parseIssues.length > 0) {
    console.log(`warnings:   ${ws.parseIssues.length} parse issue(s) — run \`pop ls\` to see them`);
  }
  return 0;
}
