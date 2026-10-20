import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir } from './helpers.js';

describe('practi init: the config home', () => {
  it('creates only practi.json (schema marker) — no practice.yaml/nodes: practices are folders elsewhere', async () => {
    const dir = tempDataDir();
    const r = await pop(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('initialized:');
    expect(r.stdout).toContain('config home');

    // the config home carries credentials + remote, nothing else
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(state).toEqual({ schema: 1 });

    // 家里不再有 workspace 标记或节点池——实践本体是自包含文件夹
    expect(fs.existsSync(path.join(dir, 'practice.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'nodes'))).toBe(false);
  });

  it('is idempotent: a second init reports "already initialized" and exits 0', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await init(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already initialized');
    // and it did not clobber the state
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'))).toEqual({ schema: 1 });
  });

  it('keeps an existing practi.json: remote set may run before init (S2-2 regression)', async () => {
    const dir = tempDataDir();
    // remote set 先于 init：practi.json 已带 remote（外加一个登记簿时代的 instance 旧键）
    fs.writeFileSync(
      path.join(dir, 'practi.json'),
      JSON.stringify({
        schema: 1,
        remote: { url: 'http://localhost:3000' },
        instance: { owner: 'xiaohong', name: 'green-tea', branch: 'main' },
      }),
      'utf8'
    );

    const r = await pop(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already initialized');

    // init 不覆写账本：remote 原样保留（instance 旧键也原样在盘上——init 不动已有文件）
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(state.remote).toEqual({ url: 'http://localhost:3000' });
    expect(state.instance).toEqual({ owner: 'xiaohong', name: 'green-tea', branch: 'main' });
    expect(fs.existsSync(path.join(dir, 'practice.yaml'))).toBe(false);

    // 下一次写盘（remote set）把登记簿时代的 instance 键自然洗净
    const rs = await pop(dir, ['remote', 'set', 'http://localhost:3000']);
    expect(rs.code).toBe(0);
    const washed = JSON.parse(fs.readFileSync(path.join(dir, 'practi.json'), 'utf8'));
    expect(washed.remote).toEqual({ url: 'http://localhost:3000' });
    expect(washed.instance).toBeUndefined();
  });

  it('config shows the resolved config home and the remote line', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['config']);
    expect(r.code).toBe(0);
    // the config home line pins the isolation: it must be OUR temp dir, never ~/.practi
    expect(r.stdout).toContain(`config home: ${path.resolve(dir)}`);
    expect(r.stdout).toMatch(/^remote:/m);
  });
});
