import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

/**
 * `practi delete` 已退役（2026-09-01 命令面定案：一个动词留一个）：
 * 撤远端认领的唯一面孔是 `practi remove <hash> --remote`。
 * 本文件钉住退役事实：delete 现在是未知命令；remove --remote 承接其全部行为。
 */
describe('practi delete is retired; remove --remote is the one face', () => {
  it('delete answers with unknown command, exit 1', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['delete', 'sha256:whatever']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: delete');
  });

  it('remove --remote still carries the behavior (offline: fails fast, local intact)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Local pop', content: 'stays' })])).stdout);

    const r = await pop(dir, ['remove', root, '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
    const ls = await pop(dir, ['ls', '--json']);
    expect(JSON.parse(ls.stdout).direct.map((v: { hash: string }) => v.hash)).toEqual([root]);
  });
});
