import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

/**
 * W_* 记录质量提示在 CLI 上的行为：**提示，不是门禁**。
 * 这一组用例同时钉住 E_/W_ 的分界——E_ 拒收（落盘但不登记，退出 1），
 * W_ 只提示（照常登记，退出 0）。
 */
describe('practi new: quality hints (W_*)', () => {
  it('prints W_THIN_CONTENT but still registers the pop as direct', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', writeDoc(dir, { name: 'Thin step', content: 'short' })]);

    expect(r.code).toBe(0); // 不阻断
    expect(r.stdout).toContain('status:   valid, registered as direct'); // 照常登记
    expect(r.stderr).toContain('W_THIN_CONTENT');
    expect(r.stderr).toContain('never block');
    // 提示里带上节点名，才找得到回去补哪一个
    expect(r.stderr).toContain('"Thin step"');
  });

  it('says nothing when the document is clean', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', writeDoc(dir, {
      name: 'Well recorded practice',
      description: 'what this does, in one line',
      content: 'An opening paragraph that explains the point of this practice.',
      children: [{
        name: 'Run the migration',
        content: 'Run `practi migrate` and wait for the per-file verification to finish.',
        outputs: [{ name: 'migrated workspace', spec: 'practi config points at the new dir' }],
      }],
    })]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('registered as direct');
    expect(r.stderr).not.toContain('quality hints');
  });

  it('groups several hints under one node, and reports W_FLAT_TREE on an ungrouped long list', async () => {
    const dir = tempDataDir();
    await init(dir);
    const steps = Array.from({ length: 9 }, (_, i) => ({
      name: `步骤 ${i + 1}`,
      content: 'x',
    }));
    const r = await pop(dir, ['new', writeDoc(dir, {
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

  it('E_* still refuses: an unknown field never registers and prints no quality hints', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', writeDoc(dir, { name: 'Bad doc', content: 'body', notAField: true })]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_SCHEMA');
    expect(r.stdout).not.toContain('registered as direct');
    expect(r.stderr).not.toContain('quality hints'); // 拒收路径根本不走到体检
  });

  it('E_BLOB_MISSING (stored but NOT registered) prints no quality hints either', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', writeDoc(dir, {
      name: 'Thin with a missing blob',
      content: 'x',
      attachments: [{ name: 'gone.png', hash: `sha256:${'a'.repeat(64)}` }],
    })]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_BLOB_MISSING');
    expect(r.stderr).toContain('NOT registered');
    expect(r.stderr).not.toContain('quality hints');
  });
});

describe('practi edit: quality hints (W_*)', () => {
  it('hints on the edited tree too, without blocking the swap', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, {
      name: 'Practice to thin out',
      description: 'described at first',
      content: 'a reasonably long opening paragraph for the first version',
    })])).stdout);

    const edited = await pop(dir, ['edit', root, writeDoc(dir, { name: 'Practice to thin out', content: 'x' })]);
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain('edited:');
    expect(edited.stderr).toContain('W_THIN_CONTENT');
    expect(edited.stderr).toContain('never block');
  });
});
