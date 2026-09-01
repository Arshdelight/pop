import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// search 三态：无旗标=混合（先本地后 hub），--local/--remote 互斥。
// 离线钉得住的：互斥拒绝、混合模式本地半场照常渲染+远端半场失败不掩本地但 exit 1、
// --local 语义不变。远端半场的真网行为在 dev hub 上人工验过。
describe('search: three modes', () => {
  it('--local and --remote together are refused', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['search', 'tea', '--local', '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('mixed (no flag): local half renders even when the hub half is unreachable, exit 1 warns', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Kimchi stew', content: 'ferment cabbage' })])).stdout);

    const r = await pop(dir, ['search', 'kimchi']);
    expect(r.code).toBe(1); // 远端半场失败要示警
    expect(r.stdout).toContain('LOCAL (workspace)');
    expect(r.stdout).toContain('Kimchi stew');
    expect(r.stdout).toContain(root.slice('sha256:'.length, 'sha256:'.length + 12));
    expect(r.stdout).toContain('REMOTE (scope: public)');
    expect(r.stderr.toLowerCase()).toContain('failed'); // 远端半场的失败走 stderr
  });

  it('mixed --json: both halves present, remote error in-band', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    await pop(dir, ['new', writeDoc(dir, { name: 'Solo doc', content: 'x' })]);

    const r = await pop(dir, ['search', 'solo', '--json']);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body.local.results.length).toBe(1);
    expect(body.local.results[0].name).toBe('Solo doc');
    expect(body.remote.error).toBeTruthy();
  });

  it('--local stays a pure local search (no network attempt)', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']); // 死端口：若碰网必失败
    await pop(dir, ['new', writeDoc(dir, { name: 'Local only', content: 'needle' })]);

    const r = await pop(dir, ['search', 'needle', '--local']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Local only');
    expect(r.stderr).toBe('');
  });
});
