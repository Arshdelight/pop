import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

// relogin = logout + login 一扇门；remote show 已砍（与 config 重复，看挂靠用 config）。
// 离线钉：relogin 的 logout 半场完成、login 半场在死端口上失败（不碰真网）。
describe('practi relogin: logout + fresh login in one step', () => {
  it('logs out first, then attempts the fresh login (dead-port remote, offline)', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);

    const r = await pop(dir, ['relogin', '--no-open']);
    expect(r.code).toBe(1); // login 半场失败
    expect(r.stdout).toContain('logged out'); // logout 半场先完成
    expect(r.stderr).toBeTruthy(); // login 的失败有话要说
  });

  it('--help prints its usage without touching anything', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['relogin', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage: practi relogin');
  });
});

describe('practi remote show is retired (config owns the display)', () => {
  it('remote show → usage error pointing at config', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['remote', 'show']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('practi remote set <url> | remove');
    expect(r.stderr).toContain('practi config');
  });

  it('bare remote → same usage error; set/remove keep working', async () => {
    const dir = tempDataDir();
    await init(dir);
    const bare = await pop(dir, ['remote']);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('usage: practi remote');

    const set = await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    expect(set.code).toBe(0);
    const rm = await pop(dir, ['remote', 'remove']);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain('falls back to the official hub');
  });
});
