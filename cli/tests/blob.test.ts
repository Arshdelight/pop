import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, sha256, storedHash, tempDataDir, writeDoc } from './helpers.js';

describe('pop blob add: stage an attachment into the workspace blob channel', () => {
  it('stores the bytes under blobs/<2hex>/<64hex> and emits the paste-ready entry', async () => {
    const dir = tempDataDir();
    await init(dir);

    const bytes = Buffer.from('fake png bytes for practi integration tests');
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, bytes);

    const r = await pop(dir, ['blob', 'add', file]);
    expect(r.code).toBe(0);

    const hash = storedHash(r.stdout);
    expect(hash).toBe(sha256(bytes));

    // the emitted entry is what an author pastes into the document's attachments
    const entry = JSON.parse(r.stdout.match(/\{[^{}]*\}/s)![0]);
    expect(entry).toEqual({ name: 'fig.png', hash, mime: 'image/png', size: bytes.length });

    // content-addressed layout: blobs/<first 2 hex>/<64 hex>, bytes intact
    const hex = hash.slice('sha256:'.length);
    const stored = path.join(dir, 'blobs', hex.slice(0, 2), hex);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored).equals(bytes)).toBe(true);
  });

  it('--name overrides the display name in the entry', async () => {
    const dir = tempDataDir();
    await init(dir);
    const bytes = Buffer.from('renamed payload');
    const file = path.join(dir, 'tmp-upload.bin');
    fs.writeFileSync(file, bytes);

    const r = await pop(dir, ['blob', 'add', file, '--name', 'result-set.json']);
    expect(r.code).toBe(0);
    const entry = JSON.parse(r.stdout.match(/\{[^{}]*\}/s)![0]);
    expect(entry.name).toBe('result-set.json');
  });
});

describe('attachment pointers validate against the stored blob', () => {
  // there is no standalone `pop validate` command: `pop new` runs the SDK's
  // validateWorkspace and gates direct registration on it, so a document whose
  // attachment pointer resolves to a stored blob registers as valid
  it('a document with a matching attachment entry is registered as direct and shows the attachment', async () => {
    const dir = tempDataDir();
    await init(dir);

    const bytes = Buffer.from('fake png bytes for practi integration tests');
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, bytes);
    const staged = await pop(dir, ['blob', 'add', file]);
    const entry = JSON.parse(staged.stdout.match(/\{[^{}]*\}/s)![0]);

    const doc = {
      name: 'Annotated step',
      content: 'See ![the figure](fig.png).',
      attachments: [entry],
    };
    const created = await pop(dir, ['new', writeDoc(dir, doc)]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('status:   valid, registered as direct');
    const root = createdRoot(created.stdout);

    // show renders the attachment with its hash (existence + hash + size checked at new-time)
    const show = await pop(dir, ['show', root]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('attachments:');
    expect(show.stdout).toContain('fig.png');
    expect(show.stdout).toContain(entry.hash.slice('sha256:'.length, 'sha256:'.length + 12));
  });

  it('a pointer to a missing blob is stored but NOT registered (validation gates registration)', async () => {
    const dir = tempDataDir();
    await init(dir);

    const ghost = `sha256:${'a'.repeat(64)}`;
    const doc = {
      name: 'Ghost attachment',
      content: 'See ![ghost](ghost.png).',
      attachments: [{ name: 'ghost.png', hash: ghost, size: 5 }],
    };
    const r = await pop(dir, ['new', writeDoc(dir, doc)]);
    expect(r.code).toBe(0); // stored, but not silently treated as valid
    expect(r.stderr).toMatch(/E_BLOB_MISSING/);
    expect(r.stderr).toContain('stored but NOT registered as direct');

    const ls = await pop(dir, ['ls', '--json']);
    expect(JSON.parse(ls.stdout).direct).toEqual([]);
  });
});
