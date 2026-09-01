import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// publish（原 submit，2026-09-01 改名）：尝试发布。ref 支持短哈希——本地工作区解析，
// 未命中回落我在 hub 上的认领前缀（唯一匹配才收）。submit 已退役。
describe('practi publish: renamed from submit, short-hash refs', () => {
  it('submit is retired (unknown command)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['submit']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: submit');
  });

  it('a local hash prefix resolves before any network (offline: credentials gate)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'To publish', content: 'x' })])).stdout);
    const prefix = root.slice('sha256:'.length, 'sha256:'.length + 8);

    const r = await pop(dir, ['publish', prefix]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in'); // 解析过了，卡在凭据闸
  });

  it('unpublish shares the same short-hash resolution', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'To unpublish', content: 'x' })])).stdout);
    const prefix = root.slice('sha256:'.length, 'sha256:'.length + 8);

    const r = await pop(dir, ['unpublish', prefix]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
  });

  it('a non-hash ref is refused up front', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['publish', 'notahash']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is not a hash');
  });

  it('no direct pops → clear empty-registry error', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['publish']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no direct pops to publish');
  });
});
