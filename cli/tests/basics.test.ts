import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

describe('practi basics: version, help, unknown commands', () => {
  it('--version and `version` exit 0 and print CLI + spec versions', async () => {
    for (const args of [['--version'], ['version'], ['-v']]) {
      const r = await pop(tempDataDir(), args);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^practi\s+\d+\.\d+/m);
      expect(r.stdout).toMatch(/^pop-spec\s+\d+\.\d+/m);
    }
  });

  it('help flags exit 0 printing the usage', async () => {
    // (bare `practi` is not exercised here: the helper always appends --data-dir,
    // which would become argv[0]; `help` hits the same branch in index.ts)
    for (const args of [['help'], ['--help'], ['-h']]) {
      const r = await pop(tempDataDir(), args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('usage:');
      expect(r.stdout).toContain('--data-dir');
    }
  });

  it('unknown command → nonzero exit, named on stderr with the usage', async () => {
    const r = await pop(tempDataDir(), ['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: frobnicate');
    expect(r.stderr).toContain('usage:');
  });

  it('missing required argument: `blob add` without a target → usage on stderr, nonzero exit', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['blob', 'add']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: practi blob add');
  });

  it('commands outside an initialized data dir fail with typed E_NOT_INITIALIZED', async () => {
    const r = await pop(tempDataDir(), ['ls']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error \[E_NOT_INITIALIZED\]/);
    expect(r.stderr).toContain('run `practi init');
  });

  it('spec prints the bundled pop-spec offline (no data dir needed)', async () => {
    const r = await pop(tempDataDir(), ['spec']);
    expect(r.code).toBe(0);
    // the whole spec document, not a summary
    expect(r.stdout.length).toBeGreaterThan(1000);
    expect(r.stdout).toMatch(/pop/i);
  });
});
