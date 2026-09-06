import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createdRoot, editedRoots, init, nodeFile, pop, readState, tempDataDir, writeDoc } from './helpers.js';

describe('pop edit: swap a direct root, default GC of unreachable nodes', () => {
  it('returns a new root hash and garbage-collects the old root from nodes/', async () => {
    const dir = tempDataDir();
    await init(dir);
    const created = await pop(dir, ['new', writeDoc(dir, { name: 'Boil water', content: 'v1' })]);
    const oldRoot = createdRoot(created.stdout);

    const r = await pop(dir, ['edit', oldRoot, writeDoc(dir, { name: 'Boil water', content: 'v2' })]);
    expect(r.code).toBe(0);
    const { oldRoot: from, newRoot } = editedRoots(r.stdout);
    expect(from).toBe(oldRoot);
    expect(newRoot).not.toBe(oldRoot);

    // the registration was swapped, the old node file was unlinked (unreachable)
    expect(readState(dir).direct).toEqual([newRoot]);
    expect(fs.existsSync(nodeFile(dir, oldRoot))).toBe(false);
    expect(fs.existsSync(nodeFile(dir, newRoot))).toBe(true);

    // and ls reflects the swap
    const ls = await pop(dir, ['ls', '--json']);
    expect(JSON.parse(ls.stdout).direct.map((v: { hash: string }) => v.hash)).toEqual([newRoot]);
  });

  it('--keep skips GC: the old node file remains on disk (as an indirect node)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const created = await pop(dir, ['new', writeDoc(dir, { name: 'Solo', content: 'v1' })]);
    const oldRoot = createdRoot(created.stdout);

    const r = await pop(dir, ['edit', oldRoot, '--keep', writeDoc(dir, { name: 'Solo', content: 'v2' })]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gc:       skipped (--keep)');
    const { newRoot } = editedRoots(r.stdout);

    // old file kept on disk, but only the new root is direct — the old one shows up as indirect
    expect(fs.existsSync(nodeFile(dir, oldRoot))).toBe(true);
    const ls = await pop(dir, ['ls', '--json']);
    const out = JSON.parse(ls.stdout);
    expect(out.direct.map((v: { hash: string }) => v.hash)).toEqual([newRoot]);
    expect(out.indirect.map((v: { hash: string }) => v.hash)).toEqual([oldRoot]);
  });

  it('nodes still referenced by another direct root survive GC', async () => {
    const dir = tempDataDir();
    await init(dir);
    // shared is direct at first; compound pins it as a ChildRef
    const shared = await pop(dir, ['new', writeDoc(dir, { name: 'Shared action', content: 'v1' })]);
    const sharedRoot = createdRoot(shared.stdout);
    const compound = await pop(dir, ['new', writeDoc(dir, { name: 'Compound', children: [{ hash: sharedRoot }, { name: 'Tail', content: 'end' }] })]);
    const compoundRoot = createdRoot(compound.stdout);

    // editing shared moves ITS registration to a new root; the old root stays
    // reachable through compound and must not be collected
    const r = await pop(dir, ['edit', sharedRoot, writeDoc(dir, { name: 'Shared action', content: 'v2' })]);
    expect(r.code).toBe(0);
    const { newRoot: sharedV2 } = editedRoots(r.stdout);
    expect(fs.existsSync(nodeFile(dir, sharedRoot))).toBe(true);

    const state = readState(dir);
    expect(new Set(state.direct)).toEqual(new Set([compoundRoot, sharedV2]));
  });
});

describe('pop ls -a: indirect visibility (nodes kept alive by direct roots)', () => {
  it('a pinned-but-unregistered node is listed as indirect, referenced by its direct root', async () => {
    const dir = tempDataDir();
    await init(dir);

    // step 1: base is direct
    const baseCreated = await pop(dir, ['new', writeDoc(dir, { name: 'Base action', content: 'v1' })]);
    const baseRoot = createdRoot(baseCreated.stdout);
    // step 2: compound pins base's root ({ "hash": ... } ChildRef)
    await pop(dir, ['new', writeDoc(dir, { name: 'Compound', children: [{ hash: baseRoot }, { name: 'Tail', content: 'end' }] })]);
    // step 3: re-register base under new content — the old root loses direct
    // status but stays alive (compound references it), i.e. it becomes indirect
    const edit = await pop(dir, ['edit', baseRoot, writeDoc(dir, { name: 'Base action', content: 'v2' })]);
    expect(edit.code).toBe(0);

    const ls = await pop(dir, ['ls', '-a', '--json']);
    expect(ls.code).toBe(0);
    const out = JSON.parse(ls.stdout);

    const directHashes = out.direct.map((v: { hash: string }) => v.hash);
    const indirectHashes = out.indirect.map((v: { hash: string }) => v.hash);
    expect(directHashes).not.toContain(baseRoot);
    expect(indirectHashes).toContain(baseRoot);
    const base = out.indirect.find((v: { hash: string }) => v.hash === baseRoot);
    expect(base).toMatchObject({ name: 'Base action', type: 'action' });

    // human mode names the referencing direct root
    const text = await pop(dir, ['ls', '-a']);
    expect(text.stdout).toContain('INDIRECT');
    expect(text.stdout).toContain('referenced by: Compound');
  });
});
