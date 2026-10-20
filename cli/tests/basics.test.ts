import { describe, expect, it } from 'vitest';
import { init, pop, runIn, tempDataDir } from './helpers.js';

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
      expect(r.stdout).toContain('usage');
      expect(r.stdout).toContain('--dir'); // 实例命令的文件夹定位选项
      expect(r.stdout).toContain('practi new <name>');
    }
  });

  it('unknown command → nonzero exit, named on stderr with the usage', async () => {
    const r = await pop(tempDataDir(), ['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: frobnicate');
    expect(r.stderr).toContain('usage');
  });

  it('retired commands exit 1 and say where the work went', async () => {
    for (const cmd of ['ls', 'edit', 'publish', 'migrate', 'instance']) {
      const r = await pop(tempDataDir(), [cmd]);
      expect(r.code, cmd).toBe(1);
      expect(r.stderr).toContain(`\`practi ${cmd}\` was retired`);
    }
  });

  it('practice commands outside a practice folder say so (the config home needs no init)', async () => {
    const home = tempDataDir();
    await init(home);
    const r = await runIn(tempDataDir(), home, ['log']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('works inside a practice folder');
    expect(r.stderr).toContain('practi new <name>');
  });

  it('missing required argument: `blob add` without a target → usage on stderr, nonzero exit', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['blob', 'add']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: practi blob add');
  });

  it('spec prints the bundled pop-spec offline (no data dir needed)', async () => {
    const r = await pop(tempDataDir(), ['spec']);
    expect(r.code).toBe(0);
    // the whole spec document, not a summary
    expect(r.stdout.length).toBeGreaterThan(1000);
    expect(r.stdout).toMatch(/pop/i);
  });
});
