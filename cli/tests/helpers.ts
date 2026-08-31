import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test helpers: every test spawns the real CLI as a subprocess, exercising the
 * shipped surface (arg parsing, exit codes, stdout/stderr) rather than
 * internal functions. Filesystem state under the temp data dir is asserted
 * with plain node fs.
 */

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The CLI entry we spawn — src, via the tsx loader (a cli devDependency) */
export const CLI_ENTRY = path.join(CLI_ROOT, 'src', 'index.ts');

export interface PopResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PopOptions {
  /** stdin for the child; empty by default so stdin-reading commands see EOF immediately, never hang */
  input?: string;
  /** Extra/overridden child env. Applied last; an undefined value drops the key
   *  (Node omits undefined-valued env entries) — how tests unset PRACTI_HOME to
   *  exercise the pointer/convention resolution layers. */
  env?: Record<string, string | undefined>;
}

/**
 * Data-dir isolation, doubly enforced (see src/state.ts + the --data-dir
 * option in src/index.ts): every invocation gets --data-dir AND a PRACTI_HOME
 * pointing at the per-test temp dir. PRACTI_HOME wins over %APPDATA%practi, so no
 * code path can fall through to the real default dir. Passing dataDir=null
 * spawns a bare run (no --data-dir, no PRACTI_HOME) for resolution-layer tests.
 */
export async function pop(dataDir: string | null, args: string[], opts: PopOptions = {}): Promise<PopResult> {
  // --data-dir must come after the subcommand: index.ts dispatches on argv[0]
  const argv = dataDir === null ? [...args] : [...args, '--data-dir', dataDir];
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, ...argv],
      {
        // cwd = the cli package: `--import tsx` resolves from the cwd's node_modules (hoisted at the repo root)
        cwd: CLI_ROOT,
        env: {
          ...process.env,
          ...(dataDir === null ? {} : { PRACTI_HOME: dataDir }),
          ...opts.env,
        },
        windowsHide: true,
        // a stuck child must fail the test, not hang
        timeout: 60_000,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        // a nonzero exit is a normal result; only spawn-level failures reject
        if (err && typeof err.code !== 'number') reject(err);
        else resolve({ code: err ? err.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    // execFile only feeds stdin for truthy `input`, so end it explicitly:
    // commands that read stdin (`pop new < file`) always see EOF
    child.stdin.on('error', () => {}); // EPIPE when the child never reads — fine
    child.stdin.end(opts.input ?? '');
  });
}

/** Per-test temp data dir — nothing here ever touches the user's real data dir */
export function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'practi-test-'));
}

export async function init(dataDir: string): Promise<PopResult> {
  return pop(dataDir, ['init']);
}

/** A node file is named by its content hash, without the sha256: prefix (store.ts) */
export function nodeFile(dataDir: string, hash: string): string {
  return path.join(dataDir, 'nodes', `${hash.slice('sha256:'.length)}.md`);
}

/** The CLI state file inside the data dir */
export function stateFile(dataDir: string): string {
  return path.join(dataDir, 'practi.json');
}

export function readState(dataDir: string): { schema: number; direct: string[]; remote?: { url: string }; claims?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'));
}

export function nodeFiles(dataDir: string): string[] {
  return fs.readdirSync(path.join(dataDir, 'nodes'));
}

function requireMatch(stdout: string, re: RegExp, what: string): RegExpMatchArray {
  const m = stdout.match(re);
  if (!m) throw new Error(`expected ${what} in CLI output:\n${stdout}`);
  return m;
}

/** `pop new` reports the new root on the `created:` line */
export function createdRoot(stdout: string): string {
  return requireMatch(stdout, /^created:\s+(sha256:[0-9a-f]{64})\s*$/m, 'a created hash')[1];
}

/** `pop edit` reports the swap on the `edited:` line */
export function editedRoots(stdout: string): { oldRoot: string; newRoot: string } {
  const m = requireMatch(stdout, /^edited:\s+(sha256:[0-9a-f]{64}) -> (sha256:[0-9a-f]{64})/m, 'an edited hash pair');
  return { oldRoot: m[1], newRoot: m[2] };
}

/** `pop blob add` reports the stored hash on the `stored:` line */
export function storedHash(stdout: string): string {
  return requireMatch(stdout, /^stored:\s+(sha256:[0-9a-f]{64})/m, 'a stored blob hash')[1];
}

/** The sha256 of bytes, as POP writes it everywhere */
export function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Write a JSON document next to the data dir and return its absolute path */
export function writeDoc(dataDir: string, doc: unknown): string {
  const file = path.join(dataDir, 'doc.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return file;
}
