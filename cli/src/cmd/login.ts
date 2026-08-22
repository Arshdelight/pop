import fs from 'node:fs';
import { defaultDataDir, loadState, saveState } from '../state.js';

export interface LoginOpts {
  dataDir?: string;
  token?: string;
}

export function runLogin(opts: LoginOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  let token = opts.token;
  if (token === undefined && !process.stdin.isTTY) token = readStdin().trim();
  if (!token) {
    console.error('usage: pop login [--token <token>]   (or pipe the token on stdin)');
    return 1;
  }
  state.auth = { token };
  saveState(dataDir, state);
  console.log(`logged in to ${state.remote.url} (token stored in ${dataDir})`);
  return 0;
}

export function runLogout(opts: { dataDir?: string }): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  delete state.auth;
  saveState(dataDir, state);
  console.log('logged out');
  return 0;
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}
