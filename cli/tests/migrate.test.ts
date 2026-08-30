import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, readState, tempDataDir } from './helpers.js';

// Migration is a protocol (pre → copy → verify → handover → record); each test
// drives the real CLI. HOME is pointed at a temp dir so the ~/.practi-home
// pointer and the ~/.practi convention location never touch the real home.

const TREE = {
  name: 'Make tea',
  children: [{ name: 'Boil water', content: 'Heat until boiling.' }],
};

async function seeded(): Promise<string> {
  const dir = tempDataDir();
  await init(dir);
  const r = await pop(dir, ['new', '--json', JSON.stringify(TREE)]);
  createdRoot(r.stdout); // assert the doc actually landed
  return dir;
}

function fakeHome(): string {
  return tempDataDir();
}

const HOME_ENV = (home: string) => ({ HOME: home, USERPROFILE: home });
const BARE_ENV = (home: string) => ({ ...HOME_ENV(home), PRACTI_HOME: undefined, POP_HOME: undefined });

describe('practi migrate: the relocation protocol', () => {
  it('moves the workspace, verifies every file, leaves a .bak, writes the pointer', async () => {
    const dir = await seeded();
    const to = tempDataDir(); // exists and is empty — an allowed target
    const home = fakeHome();

    const r = await pop(dir, ['migrate', to], { env: HOME_ENV(home) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('migrated:');
    expect(r.stdout).toContain('backup:');

    // the new home carries everything: state with the direct root, workspace files
    expect(readState(to).direct.length).toBe(1);
    expect(fs.existsSync(path.join(to, 'practice.yaml'))).toBe(true);

    // handover: the old directory was renamed away, never deleted
    const baks = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(`${path.basename(dir)}.bak-`));
    expect(baks.length).toBe(1);

    // record: an out-of-convention home persists in ~/.practi-home
    const pointer = fs.readFileSync(path.join(home, '.practi-home'), 'utf8').trim();
    expect(pointer).toBe(path.resolve(to));
  });

  it('the migrated home stays functional and a bare run resolves via the pointer', async () => {
    const dir = await seeded();
    const to = tempDataDir();
    const home = fakeHome();
    await pop(dir, ['migrate', to], { env: HOME_ENV(home) });

    const ls = await pop(to, ['ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('Make tea');

    // bare run: no --data-dir, no PRACTI_HOME — the pointer layer must win
    const cfg = await pop(null, ['config'], { env: BARE_ENV(home) });
    expect(cfg.code).toBe(0);
    expect(cfg.stdout).toContain(path.resolve(to));
    expect(cfg.stdout).toContain('pointer');
  });

  it('no-arg migrate goes to the convention location and writes NO pointer', async () => {
    const dir = await seeded();
    const home = fakeHome();

    const r = await pop(dir, ['migrate'], { env: HOME_ENV(home) });
    expect(r.code).toBe(0);

    const convention = path.join(home, '.practi');
    expect(readState(convention).direct.length).toBe(1);
    expect(fs.existsSync(path.join(home, '.practi-home'))).toBe(false);

    const cfg = await pop(null, ['config'], { env: BARE_ENV(home) });
    expect(cfg.stdout).toContain(path.resolve(convention));
    expect(cfg.stdout).toContain('convention');
  });

  it('refuses an occupied target and leaves the source untouched', async () => {
    const dir = await seeded();
    const to = tempDataDir();
    fs.writeFileSync(path.join(to, 'occupied.txt'), 'x');

    const r = await pop(dir, ['migrate', to]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not empty');
    expect(readState(dir).direct.length).toBe(1); // nothing moved
  });

  it('refuses the same directory and nested locations', async () => {
    const dir = await seeded();
    expect((await pop(dir, ['migrate', dir])).code).toBe(1);
    expect((await pop(dir, ['migrate', path.join(dir, 'nested')])).code).toBe(1);
    expect(readState(dir).direct.length).toBe(1);
  });
});
