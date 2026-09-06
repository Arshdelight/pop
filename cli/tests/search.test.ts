import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// search：纯本地工作区检索。空查询=浏览 direct 根；JSON 形状 {query, results, total}。
describe('search: local workspace', () => {
  it('matches by substring and shows the short hash', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Kimchi stew', content: 'ferment cabbage' })])).stdout);

    const r = await pop(dir, ['search', 'kimchi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew');
    expect(r.stdout).toContain(root.slice('sha256:'.length, 'sha256:'.length + 12));
  });

  it('--json: results + total, no remote key', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Solo doc', content: 'x' })]);

    const r = await pop(dir, ['search', 'solo', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.results.length).toBe(1);
    expect(body.results[0].name).toBe('Solo doc');
    expect(body.total).toBe(1);
  });

  it('empty query = browse direct roots; no match says so', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Local only', content: 'needle' })]);

    const browse = await pop(dir, ['search']);
    expect(browse.code).toBe(0);
    expect(browse.stdout).toContain('Local only');

    const miss = await pop(dir, ['search', 'zzz-no-such']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toContain('no local matches');
  });
});
