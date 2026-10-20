import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc } from './helpers.js';

// 哈希口径统一：入口接受带/不带 sha256: 的全哈希（自动补前缀）；
// 本地池内另收唯一前缀。远端入口已随 hub 下线整体移除。
describe('hash refs are uniform across commands', () => {
  /** 带首版修订的实例文件夹 */
  async function setup(name: string): Promise<{ home: string; repo: string; root: string }> {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', name, '--base', writeDoc(parent, 'seed.json', { name, content: 'x' })]);
    const repo = `${parent}/${name}`;
    return { home, repo, root: chainOf(repo).commits[0]!.root };
  }

  it('show accepts a bare full hash (normalized)', async () => {
    const { home, repo, root } = await setup('bare-p');
    const r = await runIn(repo, home, ['show', root.slice('sha256:'.length)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('bare-p');
  });

  it('show accepts a unique local prefix', async () => {
    const { home, repo, root } = await setup('pref-p');
    const r = await runIn(repo, home, ['show', root.slice('sha256:'.length, 'sha256:'.length + 8)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pref-p');
  });
});
