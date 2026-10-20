import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

/**
 * Test helpers: every test spawns the real CLI as a subprocess, exercising the
 * shipped surface (arg parsing, exit codes, stdout/stderr) rather than
 * internal functions. Filesystem state is asserted with plain node fs.
 *
 * 文件夹模型（2026-10-20）：配置家（凭据+remote）与实践文件夹分离——
 * - cfg() 类命令走 pop(cfgHome, args)（--data-dir 指配置家）
 * - 实例命令走 runIn(repoDir, args, { home: cfgHome })（cwd=实例文件夹）
 */

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The CLI entry we spawn — src, via the tsx loader (a cli devDependency).
 *  绝对 file URL：练习命令的 cwd 在临时实例文件夹， specifier 'tsx' 在那里解析不到。 */
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;

/** The CLI entry we spawn */
export const CLI_ENTRY = path.join(CLI_ROOT, 'src', 'index.ts');

export interface PopResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PopOptions {
  /** stdin for the child; empty by default so stdin-reading commands see EOF immediately, never hang */
  input?: string;
  /** Extra/overridden child env. Applied last; an undefined value drops the key. */
  env?: Record<string, string | undefined>;
}

/**
 * Config-home commands (init/login/me/remote/config/spec/fix): data-dir isolation,
 * doubly enforced (--data-dir + PRACTI_HOME). dataDir=null spawns a bare run.
 */
export async function pop(dataDir: string | null, args: string[], opts: PopOptions = {}): Promise<PopResult> {
  const argv = dataDir === null ? [...args] : [...args, '--data-dir', dataDir];
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, ...argv],
      {
        cwd: CLI_ROOT,
        env: {
          ...process.env,
          ...(dataDir === null ? {} : { PRACTI_HOME: dataDir }),
          ...opts.env,
        },
        windowsHide: true,
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') reject(err);
        else resolve({ code: err ? err.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    child.stdin.on('error', () => {}); // EPIPE when the child never reads — fine
    child.stdin.end(opts.input ?? '');
  });
}

/** Practice-folder command: cwd = the practice folder (or any subdir), PRACTI_HOME = config home. */
export async function runIn(dir: string, home: string, args: string[], opts: PopOptions = {}): Promise<PopResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, ...args],
      {
        cwd: dir,
        env: { ...process.env, PRACTI_HOME: home, ...opts.env },
        windowsHide: true,
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') reject(err);
        else resolve({ code: err ? err.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

export function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'practi-test-'));
}

export async function init(dataDir: string): Promise<PopResult> {
  return pop(dataDir, ['init']);
}

/** The practice's chain file (.practi/chain.json) */
export function chainOf(repoDir: string): {
  name: string;
  owner: string | null;
  current: string;
  branches: Record<string, string | null>;
  commits: { seq: number; root: string; parent: string | null; message: string; pushedAt?: string }[];
} {
  return JSON.parse(fs.readFileSync(path.join(repoDir, '.practi', 'chain.json'), 'utf8'));
}

/** The working file of a practice folder */
export function workingFile(repoDir: string): string {
  return path.join(repoDir, `${path.basename(repoDir)}.json`);
}

export function poolFile(repoDir: string, hash: string): string {
  return path.join(repoDir, '.practi', 'nodes', `${hash.slice('sha256:'.length)}.md`);
}

/** The sha256 of bytes, as POP writes it everywhere */
export function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Write a JSON document and return its absolute path */
export function writeDoc(dir: string, name: string, doc: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return file;
}

function requireMatch(stdout: string, re: RegExp, what: string): RegExpMatchArray {
  const m = stdout.match(re);
  if (!m) throw new Error(`expected ${what} in CLI output:\n${stdout}\n--stderr--\n`);
  return m;
}

/** `practi commit` reports the revision on the `committed:` line */
export function committedRoot(stdout: string): string {
  return requireMatch(stdout, /committed: \S+ v\d+\s+(sha256:[0-9a-f]{64})/, 'a committed hash')[1];
}

/* ── web server spawn helpers ── */

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function spawnWeb(repoDir: string, home: string, port: number): ChildProcess {
  return execFile(
    process.execPath,
    ['--import', TSX_LOADER, CLI_ENTRY, 'web', '--port', String(port), '--no-open'],
    { cwd: repoDir, env: { ...process.env, PRACTI_HOME: home }, windowsHide: true },
    () => {},
  );
}

export async function untilHealthy(port: number, child: ChildProcess, timeoutMs = 15_000): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`web server exited early with code ${child.exitCode}`);
    if (Date.now() - t0 > timeoutMs) throw new Error('web server did not become healthy in time');
    try {
      const r = await fetch(`${base}/api/repo`);
      if (r.ok) return base;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
}
