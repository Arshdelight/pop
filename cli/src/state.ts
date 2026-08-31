import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** CLI bookkeeping file inside the data directory (the data dir IS a POP workspace).
 *  旧名 pop.json 仍可读（读旧写新），写入一律走 practi.json。 */
export const STATE_FILE = 'practi.json';
const LEGACY_STATE_FILE = 'pop.json';
export const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** 默认 remote：开箱即连官方 hub；自建/本地 hub 用 `practi remote set <url>` 覆盖 */
export const DEFAULT_REMOTE_URL = 'https://practihub.com';

export interface State {
  schema: 1;
  /** Remote provider (e.g. https://practihub.com) */
  remote?: { url: string };
  /** Root hashes the user created/imported themselves (own uploads, §9.1 "direct") */
  direct: string[];
  /** 认领时刻（collapsed reflog）：hash → ISO 时间。节点是内容寻址的、内容不携带时间，
   *  时间属于引用内容的事件——与 git 的 refs/reflog 分工同构（direct=refs，本表=侧挂日志）。
   *  只由 claimDirect 盖戳；saveState 修剪不在 direct 里的孤儿。旧文件无此表=未盖戳，
   *  读取侧（web /api/directs）回落节点文件 mtime 并标注是推测值。 */
  claims?: Record<string, string>;
}

/** 注册 direct 认领的唯一咽喉点：入列 + 盖认领时刻。幂等——已在列则不动，
 *  首次认领时间得以保留（删掉重认领才会重盖）。new/edit/clone/pull/skill 一律走这里，
 *  别处直接 push state.direct 会绕过盖戳。 */
export function claimDirect(state: State, hash: string): boolean {
  if (state.direct.includes(hash)) return false;
  state.direct.push(hash);
  (state.claims ??= {})[hash] = new Date().toISOString();
  return true;
}

/* --------------------------------------------------------------- */
/* Data-directory resolution — one decision, four layers of intent  */
/* --------------------------------------------------------------- */

/**
 * Persistent home pointer: `~/.practi-home`, a single absolute path. Written
 * ONLY by `practi migrate <path>`, and only when the new home is outside the
 * discovery chain — the workspace's location cannot be recorded inside the
 * workspace itself (self-bootstrapping), so an out-of-band pointer in $HOME is
 * the only record that survives relocation. Most users never have this file.
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
 * Single source of truth for "where do I work when nobody said anything".
 * Layers, strongest intent first:
 *   session     — $PRACTI_HOME (legacy $POP_HOME still honored); tests & CI
 *   persisted   — ~/.practi-home pointer (`practi migrate <path>` writes it)
 *   convention  — ~/.practi on every platform. Deliberately NOT
 *                 %APPDATA%\practi — that path belongs to the unrelated
 *                 "practi" Electron app's data on Windows. When ~/.practi
 *                 doesn't exist yet but a pre-rename workspace does
 *                 (%APPDATA%\pop or ~/.pop), adopt it silently.
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
  const legacyCandidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'pop') : null,
    path.join(os.homedir(), '.pop'),
  ].filter((p): p is string => p !== null);
  for (const legacy of legacyCandidates) {
    if (fs.existsSync(legacy)) return { dir: legacy, via: 'convention' };
  }
  return { dir: fresh, via: 'convention' };
}

export function defaultDataDir(): string {
  return dataDirResolution().dir;
}

export function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILE);
}

/** 旧版（改名前）状态文件路径；存在则优先级低于 practi.json */
export function legacyStatePath(dataDir: string): string {
  return path.join(dataDir, LEGACY_STATE_FILE);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function loadState(dataDir: string): State {
  // 未配置（或 practi.json 不存在/损坏）时回落默认 remote：开箱即连官方 hub
  const base: State = { schema: 1, direct: [], remote: { url: DEFAULT_REMOTE_URL } };
  const p = statePath(dataDir);
  const legacy = legacyStatePath(dataDir);
  const file = fs.existsSync(p) ? p : fs.existsSync(legacy) ? legacy : null;
  if (file === null) return base;
  try {
    const rec = asRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (rec === null) return base;
    const state: State = { schema: 1, direct: [] };
    const remoteUrl = asString(asRecord(rec.remote)?.url);
    state.remote = remoteUrl ? { url: remoteUrl } : { url: DEFAULT_REMOTE_URL };
    if (Array.isArray(rec.direct)) {
      state.direct = rec.direct.filter((x): x is string => typeof x === 'string' && HASH_RE.test(x));
    }
    const claims = asRecord(rec.claims);
    if (claims) {
      const valid: Record<string, string> = {};
      for (const [k, v] of Object.entries(claims)) {
        if (HASH_RE.test(k) && typeof v === 'string') valid[k] = v;
      }
      state.claims = valid;
    }
    return state;
  } catch {
    return base;
  }
}

export function saveState(dataDir: string, state: State): void {
  // 修剪孤儿认领时刻：hash 已不在 direct（edit 换根/删除）→ 时间随之失效，
  // 不留陈旧条目。修剪放在写盘口，命令层怎么改 direct 都不会漏
  if (state.claims) {
    const live = new Set(state.direct);
    for (const h of Object.keys(state.claims)) {
      if (!live.has(h)) delete state.claims[h];
    }
    if (Object.keys(state.claims).length === 0) delete state.claims;
  }
  fs.writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
