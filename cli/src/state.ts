import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 配置家的账本（practi.json）：文件夹模型（2026-10-20 终稿）下实例=自包含文件夹，
 * 家目录只存凭据与远端——direct/claims/instance 三个旧键随 pops 登记簿退役，读旧
 * 文件时静默丢弃（下次写盘自然洗净）。
 */
export const STATE_FILE = 'practi.json';

/** 官方 hub 地址：未配置 remote 时的隐式默认（2026-11-27 拍板）——
 *  `practi remote set` 只为换 hub，`remove` 回落到这里。 */
export const DEFAULT_REMOTE_URL = 'https://practihub.com';

export interface State {
  schema: 1;
  /** Remote hub origin（如 https://practihub.com）。可缺省——未配置时 hub 命令用
   *  DEFAULT_REMOTE_URL（remoteUrl 取值）。`practi remote set|remove` 维护。 */
  remote?: { url: string };
}

/** hub 命令的统一远端取值：配置了用配置的，没配置回落官方地址。
 *  是否为默认值（`practi me` 标明来源）看 loadState(dataDir).remote 有无。 */
export function remoteUrl(dataDir: string): string {
  return loadState(dataDir).remote?.url ?? DEFAULT_REMOTE_URL;
}

/* --------------------------------------------------------------- */
/* Data-directory resolution — one decision, four layers of intent  */
/* --------------------------------------------------------------- */

/**
 * Persistent home pointer: `~/.practi-home`, a single absolute path. Written
 * ONLY by `practi migrate <path>`; most users never have this file.
 */
export const POINTER_FILE = '.practi-home';

export function pointerPath(home: string = os.homedir()): string {
  return path.join(home, POINTER_FILE);
}

/** A pointer counts only when the file exists, is non-empty, and its target
 *  directory exists; every other shape (stale/dangling) reads as no pointer. */
export function readPointer(home: string = os.homedir()): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pointerPath(home), 'utf8').trim();
  } catch {
    return null;
  }
  return raw !== '' && fs.existsSync(raw) ? raw : null;
}

export function writePointer(dir: string, home: string = os.homedir()): void {
  fs.writeFileSync(pointerPath(home), `${path.resolve(dir)}\n`, 'utf8');
}

/**
 * Single source of truth for "where do I keep config and credentials".
 * Layers, strongest intent first:
 *   session     — $PRACTI_HOME (legacy $POP_HOME still honored); tests & CI
 *   persisted   — ~/.practi-home pointer (`practi migrate <path>` writes it)
 *   convention  — ~/.practi on every platform. Deliberately NOT
 *                 %APPDATA%\practi — that path belongs to the unrelated
 *                 "practi" Electron app's data on Windows.
 * `--data-dir` outranks all layers but is per-invocation, so callers resolve
 * it themselves (`opts.dataDir ?? defaultDataDir()`).
 */
export function dataDirResolution(): { dir: string; via: 'env' | 'pointer' | 'convention' } {
  if (process.env.PRACTI_HOME) return { dir: path.resolve(process.env.PRACTI_HOME), via: 'env' };
  if (process.env.POP_HOME) return { dir: path.resolve(process.env.POP_HOME), via: 'env' };
  const pointer = readPointer();
  if (pointer) return { dir: pointer, via: 'pointer' };
  const fresh = path.join(os.homedir(), '.practi');
  if (fs.existsSync(fresh)) return { dir: fresh, via: 'convention' };
  return { dir: fresh, via: 'convention' };
}

export function defaultDataDir(): string {
  return dataDirResolution().dir;
}

export function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILE);
}

/** Resolution transparency: answers "why this directory" — explicit --data-dir,
 *  session env, persisted pointer, or convention.（原 `practi config` 的判定，
 *  config 退役后由 `practi me` 沿用） */
export function describeDataDir(explicit?: string): { dir: string; via: string } {
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function loadState(dataDir: string): State {
  const base: State = { schema: 1 };
  const p = statePath(dataDir);
  if (!fs.existsSync(p)) return base;
  try {
    const rec = asRecord(JSON.parse(fs.readFileSync(p, 'utf8')));
    if (rec === null) return base;
    const state: State = { schema: 1 };
    const remote = asRecord(rec.remote);
    if (remote && typeof remote.url === 'string' && /^https?:\/\//i.test(remote.url)) {
      state.remote = { url: remote.url };
    }
    return state;
  } catch (e) {
    console.error(`warning: ${p} is corrupt (${(e as Error).message}) — reading defaults; the next state write will OVERWRITE it, back it up now if it matters`);
    return base;
  }
}

export function saveState(dataDir: string, state: State): void {
  fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
