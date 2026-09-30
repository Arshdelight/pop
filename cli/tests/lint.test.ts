import { describe, expect, it } from 'vitest';
import { init, pop, tempDataDir, writeDoc } from './helpers.js';

/**
 * practi lint：全库记录质量审计。
 * W_* 原本只在 new/edit 那一刻出现一次，历史欠账没有任何命令能列出来。
 */
describe('practi lint', () => {
  it('is a clean bill of health for a well-recorded workspace', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, {
      name: 'Well recorded practice',
      description: 'what this does, in one line',
      content: 'An opening paragraph that explains the point of this practice.',
      children: [{
        name: 'Run the migration',
        content: 'Run the migration and wait for the per-file verification to finish.',
        outputs: [{ name: 'migrated workspace' }],
      }],
    })]);

    const r = await pop(dir, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
    expect(r.stdout).toContain('no W_* hints');
  });

  it('lists the hints a thin practice would have drawn at creation time', async () => {
    const dir = tempDataDir();
    await init(dir);
    // 建的时候是被登记的（W_ 不阻断），lint 事后能把这些欠账翻出来
    await pop(dir, ['new', writeDoc(dir, { name: 'Thin practice', content: 'x' })]);

    const r = await pop(dir, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('W_THIN_CONTENT');
    expect(r.stdout).toContain('W_NO_VERIFY');
    expect(r.stdout).toContain('"Thin practice"'); // 带节点名，找得到回去补哪个
    expect(r.stdout).toContain('by code:');
  });

  it('aggregates by code and ranks the worst nodes first', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Only thin', content: 'x' })]);
    await pop(dir, ['new', writeDoc(dir, {
      name: 'Worse practice',
      content: 'x',
      children: [{ name: '步骤 1', content: 'y' }, { name: '步骤 2', content: 'z' }],
    })]);

    const body = JSON.parse((await pop(dir, ['lint', '--json'])).stdout);
    expect(body.total).toBeGreaterThan(0);
    const codes = body.byCode.map((c: { code: string }) => c.code);
    expect(codes).toContain('W_THIN_CONTENT');
    expect(codes).toContain('W_VAGUE_NAME');
    // 每个 item 都带节点名与哈希，机器消费方不必再查一次
    expect(body.items[0]).toHaveProperty('name');
    expect(body.items[0]).toHaveProperty('hash');
    expect(body.roots).toBe(2);
  });

  it('never blocks: exit code stays 0 however bad the corpus is', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: '步骤', content: 'x' })]);
    const r = await pop(dir, ['lint']);
    expect(r.code).toBe(0);
  });

  it('says so on an empty workspace instead of pretending to be clean', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no direct pops');
  });

  it('--limit caps how many nodes are listed', async () => {
    const dir = tempDataDir();
    await init(dir);
    for (const n of ['A', 'B', 'C']) {
      await pop(dir, ['new', writeDoc(dir, { name: `Thin ${n}`, content: 'x' })]);
    }
    const r = await pop(dir, ['lint', '--limit', '1']);
    const listed = (r.stdout.match(/^ {2}"/gm) ?? []).length;
    expect(listed).toBe(1);
    expect(r.stdout).toContain('worst 1 of 3');
  });
});
