import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chainOf, pop, runIn, tempDataDir, writeDoc } from './helpers.js';

/**
 * practi fix：纯文件工具（文件夹模型下不再有 <hash>/--all 模式——实例历史归
 * .practi/chain.json，fix 只修你手上的文档文件）。剥文档里的 revisions/refines
 * （POP 2.0 移除，历史归仓库层 spec §9.1），重验、报告新哈希；--dry-run 只看不写。
 */

const FAKE = (c: string) => `sha256:${c.repeat(64)}`;

describe('practi fix: file mode', () => {
  it('strips revisions/refines recursively, rewrites in place, reports the new root', async () => {
    const dir = tempDataDir();
    const file = writeDoc(dir, 'doc.json', {
      name: 'Legacy doc',
      revisions: [{ when: '2026-08-19', what: 'initial version', from: FAKE('d') }],
      refines: FAKE('e'),
      children: [{ name: 'leaf', content: 'x', revisions: [{ when: '2026-08-18', what: 'leaf note' }] }],
    });

    const r = await pop(null, ['fix', file]);
    expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/fixed:/);
    expect(r.stdout).toMatch(/new root sha256:[0-9a-f]{64}/);
    expect(r.stdout).toMatch(/removed \$\.revisions/);
    expect(r.stdout).toMatch(/removed \$\.refines/);
    expect(r.stdout).toMatch(/removed \$\.children\[0\]\.revisions/);

    // 原地覆写后：legacy 字段消失，其余内容逐字保留
    const rewritten = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(rewritten).toEqual({ name: 'Legacy doc', children: [{ name: 'leaf', content: 'x' }] });
  });

  it('metadata 同名键不剥（只走节点层级）；--dry-run 预览不覆写', async () => {
    const dir = tempDataDir();
    const file = writeDoc(dir, 'doc.json', {
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
      revisions: [{ when: '2026-01-01', what: 'history' }],
    });

    const dry = await pop(null, ['fix', file, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/dry-run:.*stripping 1 legacy field/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
      revisions: [{ when: '2026-01-01', what: 'history' }],
    });

    const r = await pop(null, ['fix', file]);
    expect(r.code).toBe(0);
    // metadata.revisions 原样保留——剥除只发生在节点层
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
    });
  });

  it('clean 文档报告 nothing to fix；剥完仍非法的文档不覆写', async () => {
    const dir = tempDataDir();
    const clean = writeDoc(dir, 'doc.json', { name: 'Already 2.0', content: 'fine' });
    const ok = await pop(null, ['fix', clean]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/nothing to fix/);

    const broken = writeDoc(dir, 'doc.json', { name: 'Broken', revisions: [], children: 'not an array' });
    const bad = await pop(null, ['fix', broken]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/still fails validation after stripping/);
  });

  it('修完可用 new --base 收编：fixed 文件直接成为实例的第一版（串联用例）', async () => {
    const home = tempDataDir();
    const dir = tempDataDir();
    const file = writeDoc(dir, 'doc.json', {
      name: 'Legacy doc',
      revisions: [{ when: '2026-08-19', what: 'initial version', from: FAKE('d') }],
      refines: FAKE('e'),
    });

    const fixed = await pop(null, ['fix', file]);
    expect(fixed.code).toBe(0);
    const newRoot = /new root (sha256:[0-9a-f]{64})/.exec(fixed.stdout)![1];

    const r = await runIn(dir, home, ['new', 'adopted', '--base', file]);
    expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
    const repo = `${dir}/adopted`;
    expect(chainOf(repo).commits[0]!.root).toBe(newRoot); // fix 报告的哈希就是上链的身份
    expect(r.stdout).toContain('first revision: v1');
  });
});
