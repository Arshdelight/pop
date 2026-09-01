import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

// ls --remote：远端认领清单（fetchMine）。-a 是本地专属（hub 无间接视图）组合即拒；
// 离线钉凭据闸。
describe('ls --remote: hub claims listing', () => {
  it('offline: fails at the credentials gate, exit 1', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['ls', '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
  });

  it('-a with --remote is refused (local-only flag)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['ls', '-a', '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('-a is local-only');
  });

  it('--remote --json without -a reaches the credentials gate', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['ls', '--remote', '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in'); // 无 -a 组合：走到凭据闸
  });
});
