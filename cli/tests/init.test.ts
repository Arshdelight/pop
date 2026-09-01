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

    // CLI state file: schema + empty direct registry, no remote override yet
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

  it('config shows the resolved data dir, empty counts, and the default-remote fallback', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['config']);
    expect(r.code).toBe(0);
    // the data dir line pins the isolation: it must be OUR temp dir, never %APPDATA%\pop
    expect(r.stdout).toContain(`data dir:   ${path.resolve(dir)}`);
    // remote: practi.json has no remote key → loadState falls back to the default hub
    expect(r.stdout).toMatch(/^remote:\s+https:\/\/practihub\.com$/m);
    expect(r.stdout).toMatch(/^auth:\s+\(not logged in\)$/m);
    expect(r.stdout).toMatch(/^direct:\s+0$/m);
    expect(r.stdout).toMatch(/^indirect:\s+0$/m);
  });
});

describe('pop remote: the remote override stored in practi.json', () => {
  it('set persists the url (trailing slashes trimmed) and show reads it back', async () => {
    const dir = tempDataDir();
    await init(dir);

    const set = await pop(dir, ['remote', 'set', 'https://hub.example.com///']);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('remote set: https://hub.example.com');

    // remote show 已砍：config 承接展示（remote: 行）
    const config1 = await pop(dir, ['config']);
    expect(config1.stdout).toMatch(/^remote:\s+https:\/\/hub\.example\.com$/m);

    // persisted in practi.json, and config reflects it
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(state.remote).toEqual({ url: 'https://hub.example.com' });
    const config = await pop(dir, ['config']);
    expect(config.stdout).toMatch(/^remote:\s+https:\/\/hub\.example\.com$/m);
  });

  it('set rejects a non-URL without touching the state', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['remote', 'set', 'not-a-url']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not an http(s) URL');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8')).remote).toBeUndefined();
  });

  it('remove clears the override — the effective remote falls back to the default hub again', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'https://hub.example.com']);

    const rm = await pop(dir, ['remote', 'remove']);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain('remote removed');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(state.remote).toBeUndefined();

    // loadState re-applies the built-in default when the key is absent:
    // removal clears the override, it does not blank the effective remote
    const config2 = await pop(dir, ['config']);
    expect(config2.stdout).toMatch(/^remote:\s+https:\/\/practihub\.com$/m);
  });
});
