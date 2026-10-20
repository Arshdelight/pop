import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc, workingFile } from './helpers.js';

/**
 * practi lint：**当前支头**的记录质量审计（文件夹模型下 lint 只看 head 文档，
 * 不再扫全库）。W_* 原本只在 new/commit 那一刻出现一次，历史欠账没有任何命令
 * 能列出来——lint 就是那道门；提交一版修好的内容，欠账即从清单上消失。
 */
describe('practi lint', () => {
  it('is a clean bill of health for a well-recorded head', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'good-p', '--base', writeDoc(parent, 'good.json', {
      name: 'Well recorded practice',
      description: 'what this does, in one line',
      content: 'An opening paragraph that explains the point of this practice.',
      children: [{
        name: 'Run the migration',
        content: 'Run the migration and wait for the per-file verification to finish.',
        outputs: [{ name: 'migrated workspace' }],
      }],
    })]);

    const r = await runIn(`${parent}/good-p`, home, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
    expect(r.stdout).toContain('no W_* hints');
  });

  it('lists the hints a thin head would have drawn at commit time', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'thin-p', '--base', writeDoc(parent, 'thin.json', { name: 'Thin practice', content: 'x' })]);

    const r = await runIn(`${parent}/thin-p`, home, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('W_THIN_CONTENT');
    expect(r.stdout).toContain('W_NO_VERIFY');
    expect(r.stdout).toContain('"Thin practice"'); // 带节点名，找得到回去补哪个
    expect(r.stdout).toContain('by code:');
  });

  it('audits only the current branch head: a fixed commit clears the list (old revisions stay in the pool)', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'thin-p', '--base', writeDoc(parent, 'thin.json', { name: 'Thin practice', content: 'x' })]);
    const repo = `${parent}/thin-p`;
    expect((await runIn(repo, home, ['lint'])).stdout).toContain('W_THIN_CONTENT');

    // 修好并提交 → lint 干净；池里旧节点还在（共 2 个），但审计对象只有新头
    fs.writeFileSync(workingFile(repo), JSON.stringify({
      name: 'Thin practice',
      description: 'now properly described',
      content: 'An opening paragraph that explains the point of this practice.',
      outputs: [{ name: 'a verifiable outcome' }],
    }, null, 2) + '\n', 'utf8');
    expect((await runIn(repo, home, ['commit', '-m', 'fill in the blanks'])).code).toBe(0);
    expect(chainOf(repo).commits).toHaveLength(2);

    const r = await runIn(repo, home, ['lint']);
    expect(r.stdout).toContain('clean');
    expect(r.stdout).toContain('2 node(s) in the pool'); // 旧节点仍在池里，只是不再被审
  });

  it('aggregates by code and carries name + hash on every item (--json)', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'vague-p', '--base', writeDoc(parent, 'vague.json', {
      name: 'Worse practice',
      content: 'x',
      children: [{ name: '步骤 1', content: 'y' }, { name: '步骤 2', content: 'z' }],
    })]);

    const body = JSON.parse((await runIn(`${parent}/vague-p`, home, ['lint', '--json'])).stdout);
    expect(body.total).toBeGreaterThan(0);
    expect(body.branch).toBe('main');
    const codes = body.byCode.map((c: { code: string }) => c.code);
    expect(codes).toContain('W_THIN_CONTENT');
    expect(codes).toContain('W_VAGUE_NAME');
    // 每个 item 都带节点名与哈希，机器消费方不必再查一次
    expect(body.items[0]).toHaveProperty('name');
    expect(body.items[0]).toHaveProperty('hash');
  });

  it('never blocks: exit code stays 0 however bad the head is', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'thin-p', '--base', writeDoc(parent, 'thin.json', { name: '步骤', content: 'x' })]);
    const r = await runIn(`${parent}/thin-p`, home, ['lint']);
    expect(r.code).toBe(0);
  });

  it('says so on an empty practice instead of pretending to be clean', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    await runIn(parent, home, ['new', 'empty-p']);
    const r = await runIn(`${parent}/empty-p`, home, ['lint']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('(empty) empty-p@main');
  });

  it('lists every hint-carrying head node, worst first', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    // 头文档带 3 个含提示的子步骤 → 3 组节点欠账
    await runIn(parent, home, ['new', 'wide-p', '--base', writeDoc(parent, 'wide.json', {
      name: 'Holder practice',
      description: 'described so the root itself is not questioned',
      content: 'A reasonable opening paragraph for the root practice.',
      children: [
        { name: 'Thin A', content: 'x' },
        { name: 'Thin B', content: 'x' },
        { name: 'Thin C', content: 'x' },
      ],
    })]);
    const r = await runIn(`${parent}/wide-p`, home, ['lint']);
    const listed = (r.stdout.match(/^ {2}"/gm) ?? []).length;
    expect(listed).toBe(3);
    expect(r.stdout).toContain('worst 3 of 3');
  });
});
