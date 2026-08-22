import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** CLI bookkeeping file inside the data directory (the data dir IS a POP workspace) */
export const STATE_FILE = 'pop.json';
export const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export interface State {
  schema: 1;
  /** Remote provider (e.g. https://practihub.com) */
  remote?: { url: string };
  /** Stored credentials for the remote */
  auth?: { token?: string };
  /** Root hashes the user created/imported themselves (own uploads, §9.1 "direct") */
  direct: string[];
}

/** Default data directory: $POP_HOME, else %APPDATA%\pop (Windows), else ~/.pop */
export function defaultDataDir(): string {
  if (process.env.POP_HOME) return path.resolve(process.env.POP_HOME);
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, 'pop');
  return path.join(os.homedir(), '.pop');
}

export function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILE);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function loadState(dataDir: string): State {
  const p = statePath(dataDir);
  const base: State = { schema: 1, direct: [] };
  if (!fs.existsSync(p)) return base;
  try {
    const rec = asRecord(JSON.parse(fs.readFileSync(p, 'utf8')));
    if (rec === null) return base;
    const state: State = { schema: 1, direct: [] };
    const remoteUrl = asString(asRecord(rec.remote)?.url);
    if (remoteUrl) state.remote = { url: remoteUrl };
    const token = asString(asRecord(rec.auth)?.token);
    if (token) state.auth = { token };
    if (Array.isArray(rec.direct)) {
      state.direct = rec.direct.filter((x): x is string => typeof x === 'string' && HASH_RE.test(x));
    }
    return state;
  } catch {
    return base;
  }
}

export function saveState(dataDir: string, state: State): void {
  fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
