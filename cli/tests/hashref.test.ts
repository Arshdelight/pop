import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// 哈希口径统一：入口接受带/不带 sha256: 的全哈希（自动补前缀）；
// 本地工作区内另收唯一前缀。远端入口已随 hub 下线整体移除。
describe('hash refs are uniform across commands', () => {
  it('show accepts a bare full hash (normalized)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Bare', content: 'x' })])).stdout);
    const r = await pop(dir, ['show', root.slice('sha256:'.length)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Bare');
  });

  it('show accepts a unique local prefix', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Pref', content: 'x' })])).stdout);
    const r = await pop(dir, ['show', root.slice('sha256:'.length, 'sha256:'.length + 8)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Pref');
  });
});
