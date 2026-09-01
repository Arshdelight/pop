import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// 哈希口径统一（2026-09-11 定案）：所有入口接受带/不带 sha256: 的全哈希（自动补前缀）；
// 有登记簿可查的（本地工作区或我的远端认领）另收唯一前缀。clone/comment 评的是任意
// 公开内容，前缀无处可靠解析——全哈希必收。
describe('hash refs are uniform across commands', () => {
  it('remove --remote resolves a local prefix before the credentials gate', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'R', content: 'x' })])).stdout);
    const r = await pop(dir, ['remove', root.slice('sha256:'.length, 'sha256:'.length + 8), '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in'); // 解析过了，卡在凭据闸
  });

  it('remove --remote accepts a bare full hash (normalized, same gate)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Bare', content: 'x' })])).stdout);
    const r = await pop(dir, ['remove', root.slice('sha256:'.length), '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
  });

  it('clone normalizes a bare full hash (fails at auth, not at parsing)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['clone', 'a'.repeat(64)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
    expect(r.stderr).not.toContain('not a full hash');
  });

  it('clone refuses a short prefix with a clear pointer to search', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['clone', 'abcd1234']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not a full hash');
  });

  it('comment list normalizes a bare full hash (auth gate, not parse error)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['comment', 'list', 'b'.repeat(64)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
    expect(r.stderr).not.toContain('not a full hash');
  });

  it('comment list refuses a short prefix up front', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['comment', 'list', 'abcd']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not a full hash');
  });
});
