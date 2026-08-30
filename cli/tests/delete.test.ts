import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

/**
 * `pop delete <hash>` is a REMOTE-only operation (lifecycle.ts → DELETE on the
 * hub; the local workspace is deliberately untouched). There is no offline
 * local-unregister command, so the no-network coverage here pins two facts:
 * the argument contract, and that an offline delete fails fast (before any
 * network call) while the local registration survives.
 */
describe('pop delete: remote-only by design', () => {
  it('without a hash: index.ts answers with the usage on stdout, exit 0 (argless delete is a help, not an error)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['delete']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage: practi delete');
    expect(r.stderr).toBe('');
  });

  it('offline: fails fast (not logged in) and leaves the local registration intact', async () => {
    const dir = tempDataDir();
    await init(dir);
    const created = await pop(dir, ['new', writeDoc(dir, { name: 'Local pop', content: 'stays' })]);
    const root = createdRoot(created.stdout);

    const r = await pop(dir, ['delete', root]);
    expect(r.code).toBe(1);
    // requireCredentials throws before any HTTP call — no network dependency in the test
    expect(r.stderr).toContain('not logged in');

    // the local direct registration is untouched (delete never edits practi.json)
    const ls = await pop(dir, ['ls', '--json']);
    expect(JSON.parse(ls.stdout).direct.map((v: { hash: string }) => v.hash)).toEqual([root]);
  });
});
