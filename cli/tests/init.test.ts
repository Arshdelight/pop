import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

/**
 * 配置面（2026-11-27）：`practi init` / `practi config` 退役并入 `practi me`；
 * 未配置 remote 时 hub 命令默认 https://practihub.com。这里断言退役存根与
 * `me` 未登录时的新输出（配置家 + remote 来源）。
 */
describe('retired config surface: init/config → practi me', () => {
  it('`practi init` is a retired stub: exit 1, points at `practi me`', async () => {
    const dir = tempDataDir();
    const r = await pop(dir, ['init']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('`practi init` was retired');
    expect(r.stderr).toMatch(/`practi me`/);
    expect(r.stdout).toBe('');
  });

  it('`practi config` is a retired stub: exit 1, points at `practi me`', async () => {
    const dir = tempDataDir();
    const r = await pop(dir, ['config']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('`practi config` was retired');
    expect(r.stderr).toMatch(/merged into `practi me`/);
  });

  it('`practi me` unsigned-in: prints the config home (pinned to OUR dir) and the default remote, hints login', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['me']);
    expect(r.code).toBe(1);
    // the config home line pins the isolation: it must be OUR temp dir, never ~/.practi
    expect(r.stdout).toContain(`config home: ${path.resolve(dir)}`);
    expect(r.stdout).toContain('(via');
    // no practi.json → the remote line names the default, not an error
    expect(r.stdout).toContain('remote:     https://practihub.com');
    expect(r.stdout).toContain('(default');
    expect(r.stdout).not.toContain('(set with');
    // unsigned-in: told where to go (stderr, exit 1)
    expect(r.stderr).toMatch(/not logged in — run `practi login` first/);
  });

  it('`practi me` with a configured remote names it as `remote set`, not the default', async () => {
    const dir = tempDataDir();
    await init(dir);
    const rs = await pop(dir, ['remote', 'set', 'http://127.0.0.1:1']);
    expect(rs.code).toBe(0);
    const r = await pop(dir, ['me']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('remote:     http://127.0.0.1:1');
    expect(r.stdout).toContain('(set with `practi remote set`)');
    expect(r.stdout).not.toContain('https://practihub.com');
  });
});
