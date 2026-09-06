import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

describe('pop init: the data directory', () => {
  it('creates practi.json (CLI state) + practice.yaml (workspace marker) + nodes/', async () => {
    const dir = tempDataDir();
    const r = await pop(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('initialized:');

    // CLI state file: schema + empty direct registry
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(state).toEqual({ schema: 1, direct: [] });

    // the data dir IS a POP workspace (store.ts markers)
    expect(fs.existsSync(path.join(dir, 'practice.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'nodes'))).toBe(true);
  });

  it('is idempotent: a second init reports "already initialized" and exits 0', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await init(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already initialized');
    // and it did not clobber the state
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'))).toEqual({ schema: 1, direct: [] });
  });

  it('adopts a pre-rename workspace: legacy pop.json is read, practi.json is written', async () => {
    const dir = tempDataDir();
    // pre-rename shape: initialized workspace whose state still lives in pop.json
    await pop(dir, ['init']);
    fs.renameSync(path.join(dir, 'practi.json'), path.join(dir, 'pop.json'));

    const r = await pop(dir, ['config']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`data dir:   ${path.resolve(dir)}`);
    // init recognizes the legacy state file (no "not initialized" error, no clobber)
    const again = await init(dir);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already initialized');
    expect(fs.existsSync(path.join(dir, 'pop.json'))).toBe(true);
  });

  it('config shows the resolved data dir and empty counts', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['config']);
    expect(r.code).toBe(0);
    // the data dir line pins the isolation: it must be OUR temp dir, never %APPDATA%\pop
    expect(r.stdout).toContain(`data dir:   ${path.resolve(dir)}`);
    expect(r.stdout).toMatch(/^direct:\s+0$/m);
    expect(r.stdout).toMatch(/^indirect:\s+0$/m);
  });
});
