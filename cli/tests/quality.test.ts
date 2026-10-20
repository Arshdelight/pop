import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc, workingFile } from './helpers.js';

/**
 * W_* 记录质量提示在 CLI 上的行为：**提示，不是门禁**。
 * 这一组用例同时钉住 E_/W_ 的分界——E_ 拒收（new --base 不落盘 / commit 回滚链），
 * W_ 只提示（照常成 revision，退出 0）。
 */
describe('practi new --base: quality hints (W_*)', () => {
  it('prints W_THIN_CONTENT but still records v1', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const r = await runIn(parent, home, ['new', 'thin-p', '--base', writeDoc(parent, 'thin.json', { name: 'Thin step', content: 'short' })]);

    expect(r.code).toBe(0); // 不阻断
    expect(r.stdout).toContain('first revision: v1'); // 照常上链
    expect(chainOf(`${parent}/thin-p`).commits).toHaveLength(1);
    expect(r.stderr).toContain('W_THIN_CONTENT');
    expect(r.stderr).toContain('never block');
    // 提示里带上节点名，才找得到回去补哪一个
    expect(r.stderr).toContain('"Thin step"');
  });

  it('says nothing when the document is clean', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const r = await runIn(parent, home, ['new', 'good-p', '--base', writeDoc(parent, 'good.json', {
      name: 'Well recorded practice',
      description: 'what this does, in one line',
      content: 'An opening paragraph that explains the point of this practice.',
      children: [{
        name: 'Run the migration',
        content: 'Run the migration and wait for the per-file verification to finish.',
        outputs: [{ name: 'migrated workspace', spec: 'practi config points at the new dir' }],
      }],
    })]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('first revision: v1');
    expect(r.stderr).not.toContain('quality hints');
  });

  it('groups several hints under one node, and reports W_FLAT_TREE on an ungrouped long list', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const steps = Array.from({ length: 9 }, (_, i) => ({
      name: `步骤 ${i + 1}`,
      content: 'x',
    }));
    const r = await runIn(parent, home, ['new', 'flat-p', '--base', writeDoc(parent, 'flat.json', {
      name: 'Flat and vague',
      description: 'has a description, so only the structure is questioned',
      content: 'body',
      children: steps,
    })]);

    expect(r.code).toBe(0);
    expect(r.stderr).toContain('W_FLAT_TREE');
    expect(r.stderr).toContain('W_VAGUE_NAME');
    expect(r.stderr).toContain('W_NO_VERIFY');
    expect(r.stderr).toContain('9 child steps');
  });

  it('E_* still refuses: an unknown field never creates a folder and prints no quality hints', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const r = await runIn(parent, home, ['new', 'bad-p', '--base', writeDoc(parent, 'bad.json', { name: 'Bad doc', content: 'body', notAField: true })]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_SCHEMA');
    expect(fs.existsSync(`${parent}/bad-p`)).toBe(false); // 干净拒绝，不留半截文件夹
    expect(r.stderr).not.toContain('quality hints'); // 拒收路径根本不走到体检
  });

  it('E_BLOB_MISSING (born empty, nothing committed) prints no quality hints either', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const r = await runIn(parent, home, ['new', 'ghost-p', '--base', writeDoc(parent, 'ghost.json', {
      name: 'Thin with a missing blob',
      content: 'x',
      attachments: [{ name: 'gone.png', hash: `sha256:${'a'.repeat(64)}` }],
    })]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_BLOB_MISSING');
    expect(r.stderr).toContain('not committed'); // 回滚诞生：链清空、工作文件撤掉
    expect(fs.existsSync(path.join(parent, 'ghost-p', 'ghost-p.json'))).toBe(false);
    expect(r.stderr).not.toContain('quality hints');
  });
});

describe('practi commit: quality hints (W_*)', () => {
  it('hints on the committed revision too, without blocking the snapshot', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const file = writeDoc(parent, 'seed.json', {
      name: 'Practice to thin out',
      description: 'described at first',
      content: 'a reasonably long opening paragraph for the first version',
    });
    await runIn(parent, home, ['new', 'thin-out', '--base', file]);
    const repo = `${parent}/thin-out`;

    fs.writeFileSync(workingFile(repo), JSON.stringify({ name: 'Practice to thin out', content: 'x' }, null, 2) + '\n', 'utf8');
    const c = await runIn(repo, home, ['commit', '-m', 'thin it out']);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain('committed:');
    expect(c.stderr).toContain('W_THIN_CONTENT');
    expect(c.stderr).toContain('never block');
  });
});
