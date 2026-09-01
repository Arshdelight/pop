import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

// --reauth（原 relogin 命令改为 login 旗标，2026-09-01 词汇定案：relogin 非规范英语，
// re-authenticate 是 OAuth 正规词）：logout + login 一步；未登录时无痕退化纯 login。
// relogin 命令随之退役。
describe('practi login --reauth', () => {
  it('not logged in: degrades to a plain login (no "logged out" noise), dead-port offline', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);

    const r = await pop(dir, ['login', '--no-open', '--reauth']);
    expect(r.code).toBe(1); // login 半场在死端口上失败
    expect(r.stdout).not.toContain('logged out'); // 未登录=无痕
    expect(r.stdout).toContain('logging in to http://127.0.0.1:9');
  });

  it('logged in (stale creds): logs out first, then the fresh login proceeds', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    // 造一份本地凭据（过期 access + 假 refresh）——revoke 走死端口是 best-effort 吞掉
    fs.writeFileSync(path.join(dir, 'practi.auth.json'), JSON.stringify({
      schema: 1, client_id: 'client-x', resource: 'http://127.0.0.1:9/cli',
      scope: 'pop:read', client_name: 'practi cli',
      access_token: 'at', refresh_token: 'rt', expires_at: 0,
    }));

    const r = await pop(dir, ['login', '--no-open', '--reauth']);
    expect(r.code).toBe(1); // 后续 login 半场失败
    expect(r.stdout).toContain('logged out'); // 先退出了
    expect(fs.existsSync(path.join(dir, 'practi.auth.json'))).toBe(false); // 凭据已清
  });

  it('already logged in without --reauth still refuses and points at the flag', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    fs.writeFileSync(path.join(dir, 'practi.auth.json'), JSON.stringify({
      schema: 1, client_id: 'client-x', resource: 'http://127.0.0.1:9/cli',
      scope: 'pop:read', client_name: 'practi cli',
      access_token: 'at', refresh_token: 'rt', expires_at: 0,
    }));

    const r = await pop(dir, ['login', '--no-open']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('login --reauth');
  });

  it('relogin command is retired (unknown command)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['relogin']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: relogin');
  });
});
