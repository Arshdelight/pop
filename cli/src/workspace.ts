import fs from 'node:fs';
import path from 'node:path';
import { PracticeError, initWorkspace, loadWorkspace, type Workspace } from '@arshdelight/pop-sdk';
import { statePath, legacyStatePath } from './state.js';

/** A data dir is initialized when it carries both the CLI state (practi.json,
 *  legacy pop.json counts) and the POP workspace marker */
export function isInitialized(dataDir: string): boolean {
  const hasState = fs.existsSync(statePath(dataDir)) || fs.existsSync(legacyStatePath(dataDir));
  return hasState && fs.existsSync(path.join(dataDir, 'practice.yaml'));
}

export function requireDataDir(dataDir: string): void {
  if (!isInitialized(dataDir)) {
    throw new PracticeError('E_NOT_INITIALIZED', `no practi data directory at ${dataDir}`, {
      hint: 'run `practi init <path>` first (or pass --data-dir)',
    });
  }
}

export function openWorkspace(dataDir: string): Workspace {
  requireDataDir(dataDir);
  return loadWorkspace(dataDir);
}

/** Create the data dir (idempotent): workspace + CLI state. Adopts an existing workspace if present. */
export function initDataDir(dataDir: string): 'created' | 'exists' {
  fs.mkdirSync(dataDir, { recursive: true });
  if (isInitialized(dataDir)) return 'exists';
  try {
    initWorkspace(dataDir);
  } catch (e) {
    // practice.yaml already exists (workspace created by another tool); we still adopt it
    if (!(e instanceof PracticeError && e.code === 'E_EXISTS')) throw e;
  }
  fs.writeFileSync(statePath(dataDir), JSON.stringify({ schema: 1, direct: [] }, null, 2) + '\n', 'utf8');
  return 'created';
}
