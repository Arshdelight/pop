import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, sha256, tempDataDir, writeDoc, workingFile } from './helpers.js';

const SEED = { name: 'Seed practice', description: 'holds the pool for attachments', content: 'A body long enough to stand as the first revision.' };

/** 一个带首版修订的实例文件夹 */
async function setup(): Promise<{ home: string; parent: string; repo: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  const file = writeDoc(parent, 'seed.json', SEED);
  await runIn(parent, home, ['new', 'my-practice', '--base', file]);
  return { home, parent, repo: path.join(parent, 'my-practice') };
}

function storedHash(stdout: string): string {
  const m = stdout.match(/^stored:  (sha256:[0-9a-f]{64})/m);
  if (!m) throw new Error(`expected a "stored:" line:\n${stdout}`);
  return m[1];
}

function blobFile(repo: string, hash: string): string {
  const hex = hash.slice('sha256:'.length);
  return path.join(repo, '.practi', 'blobs', hex.slice(0, 2), hex);
}

describe('practi blob add: stage an attachment into the instance blob channel', () => {
  it('stores the bytes under .practi/blobs/<2hex>/<64hex> and emits the paste-ready entry', async () => {
    const { home, parent, repo } = await setup();

    const bytes = Buffer.from('fake png bytes for practi integration tests');
    const file = path.join(parent, 'fig.png');
    fs.writeFileSync(file, bytes);

    const r = await runIn(repo, home, ['blob', 'add', file]);
    expect(r.code).toBe(0);

    const hash = storedHash(r.stdout);
    expect(hash).toBe(sha256(bytes));

    // the emitted entry is what an author pastes into the document's attachments
    const entry = JSON.parse(r.stdout.match(/\{[^{}]*\}/s)![0]);
    expect(entry).toEqual({ name: 'fig.png', hash, mime: 'image/png', size: bytes.length });

    // content-addressed layout inside the instance: .practi/blobs/<first 2 hex>/<64 hex>, bytes intact
    const stored = blobFile(repo, hash);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored).equals(bytes)).toBe(true);
  });

  it('--name overrides the display name in the entry', async () => {
    const { home, parent, repo } = await setup();
    const bytes = Buffer.from('renamed payload');
    const file = path.join(parent, 'tmp-upload.bin');
    fs.writeFileSync(file, bytes);

    const r = await runIn(repo, home, ['blob', 'add', file, '--name', 'result-set.json']);
    expect(r.code).toBe(0);
    const entry = JSON.parse(r.stdout.match(/\{[^{}]*\}/s)![0]);
    expect(entry.name).toBe('result-set.json');
  });
});

describe('attachment pointers validate against the instance blob channel', () => {
  it('blob add → paste into the working file → commit → the head revision shows the attachment', async () => {
    const { home, parent, repo } = await setup();

    const bytes = Buffer.from('fake png bytes for practi integration tests');
    const file = path.join(parent, 'fig.png');
    fs.writeFileSync(file, bytes);
    const staged = await runIn(repo, home, ['blob', 'add', file]);
    const entry = JSON.parse(staged.stdout.match(/\{[^{}]*\}/s)![0]);

    // the blob is already in this instance's pool → the commit passes validation
    const doc = {
      name: 'Annotated step',
      content: 'See ![the figure](fig.png).',
      attachments: [entry],
    };
    fs.writeFileSync(workingFile(repo), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    const c = await runIn(repo, home, ['commit', '-m', 'attach the figure']);
    expect(c.code, `stdout=${c.stdout} stderr=${c.stderr}`).toBe(0);
    const head = chainOf(repo).branches.main!;

    // show renders the attachment with its hash (existence + hash + size checked at commit-time)
    const show = await runIn(repo, home, ['show', head]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('attachments:');
    expect(show.stdout).toContain('fig.png');
    expect(show.stdout).toContain(entry.hash.slice('sha256:'.length, 'sha256:'.length + 12));
  });

  it('a pointer to a missing blob refuses the commit and rolls the chain back', async () => {
    const { home, repo } = await setup();

    const ghost = `sha256:${'a'.repeat(64)}`;
    const doc = {
      name: 'Ghost attachment',
      content: 'See ![ghost](ghost.png).',
      attachments: [{ name: 'ghost.png', hash: ghost, size: 5 }],
    };
    fs.writeFileSync(workingFile(repo), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    const r = await runIn(repo, home, ['commit', '-m', 'ghost']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/E_BLOB_MISSING/);
    expect(r.stderr).toContain('not committed');

    // 链回滚：头仍是 v1，ghost 修订不上链
    expect(chainOf(repo).commits).toHaveLength(1);
  });
});
