import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, nodeFile, pop, readState, tempDataDir, writeDoc } from './helpers.js';

/**
 * practi fix：v1 → 2.0 迁移命令。剥文档里的 revisions/refines（POP 2.0 移除，
 * 历史归仓库层 spec §9.1），重验、报告新哈希。文件模式原地覆写；工作区模式
 * 落新节点文件并换绑 direct/claims；--all 扫全部 direct；--dry-run 只看不写。
 */

const FAKE = (c: string) => `sha256:${c.repeat(64)}`;

/** 手工造一个 v1 形态的存量节点文件（frontmatter 带 revisions），返回其哈希 */
function seedLegacyNode(dir: string, nameChar: string): string {
  const hash = `sha256:${nameChar.repeat(64)}`;
  const fm = [
    '---',
    "type: action",
    `name: 'Legacy ${nameChar}'`,
    'revisions:',
    "  - when: '2026-08-19'",
    "    what: 'initial version'",
    `    from: '${FAKE('d')}'`,
    '---',
    '',
    'legacy body content',
    '',
  ].join('\n');
  fs.writeFileSync(nodeFile(dir, hash), fm, 'utf8');
  return hash;
}

describe('practi fix: file mode', () => {
  it('strips revisions/refines recursively, rewrites in place, reports the new root', async () => {
    const dir = tempDataDir();
    await init(dir);
    const file = writeDoc(dir, {
      name: 'Legacy doc',
      revisions: [{ when: '2026-08-19', what: 'initial version', from: FAKE('d') }],
      refines: FAKE('e'),
      children: [{ name: 'leaf', content: 'x', revisions: [{ when: '2026-08-18', what: 'leaf note' }] }],
    });

    const r = await pop(dir, ['fix', file]);
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
    await init(dir);
    const file = writeDoc(dir, {
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
      revisions: [{ when: '2026-01-01', what: 'history' }],
    });

    const dry = await pop(dir, ['fix', file, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/dry-run:.*stripping 1 legacy field/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
      revisions: [{ when: '2026-01-01', what: 'history' }],
    });

    const r = await pop(dir, ['fix', file]);
    expect(r.code).toBe(0);
    // metadata.revisions 原样保留——剥除只发生在节点层
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      name: 'Doc',
      metadata: { revisions: 'user data, not a protocol field' },
    });
  });

  it('clean 文档报告 nothing to fix；剥完仍非法的文档不覆写', async () => {
    const dir = tempDataDir();
    await init(dir);
    const clean = writeDoc(dir, { name: 'Already 2.0', content: 'fine' });
    const ok = await pop(dir, ['fix', clean]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/nothing to fix/);

    const broken = writeDoc(dir, { name: 'Broken', revisions: [], children: 'not an array' });
    const bad = await pop(dir, ['fix', broken]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/still fails validation after stripping/);
  });
});

describe('practi fix: workspace mode', () => {
  it('fix <hash>: 剥字段落新节点文件，direct/claims 换绑且认领时间戳保留', async () => {
    const dir = tempDataDir();
    await init(dir);
    const oldHash = seedLegacyNode(dir, 'a');
    const stamp = '2026-08-23T06:08:42.793Z';
    const stateFile = path.join(dir, 'practi.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { direct: string[]; claims: Record<string, string> };
    state.direct.push(oldHash);
    state.claims = { [oldHash]: stamp };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

    const r = await pop(dir, ['fix', oldHash.slice(7, 19)]);
    expect(r.code, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
    const m = r.stdout.match(/fixed:\s+(sha256:[0-9a-f]{64}) -> (sha256:[0-9a-f]{64})/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(oldHash);
    const newHash = m![2];

    // 新节点文件落盘（旧文件留给 GC），direct 换绑，claims 戳随迁
    expect(fs.existsSync(nodeFile(dir, newHash))).toBe(true);
    expect(fs.existsSync(nodeFile(dir, oldHash))).toBe(true);
    const after = readState(dir);
    expect(after.direct).toContain(newHash);
    expect(after.direct).not.toContain(oldHash);
    expect(after.claims?.[newHash]).toBe(stamp);
    expect(after.claims?.[oldHash]).toBeUndefined();
  });

  it('干净节点报告 nothing to fix；不存在的引用报错', async () => {
    const dir = tempDataDir();
    await init(dir);
    const created = await pop(dir, ['new', writeDoc(dir, { name: 'Fresh', content: 'v2 native' })]);
    const root = /sha256:[0-9a-f]{64}/.exec(created.stdout)![0];

    const ok = await pop(dir, ['fix', root]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/nothing to fix/);

    const missing = await pop(dir, ['fix', `sha256:${'9'.repeat(64)}`]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no stored node matches/);
  });
});

describe('practi fix: --all sweep', () => {
  it('只修带 legacy 字段的 direct，干净的直接跳过；--dry-run 全程不写', async () => {
    const dir = tempDataDir();
    await init(dir);
    const oldHash = seedLegacyNode(dir, 'b');
    const stateFile = path.join(dir, 'practi.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { direct: string[] };
    state.direct.push(oldHash);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

    const dry = await pop(dir, ['fix', '--all', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/1 of 1 direct pop\(s\) would be fixed/);
    expect(fs.existsSync(nodeFile(dir, oldHash))).toBe(true);

    const r = await pop(dir, ['fix', '--all']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/fix --all done: 1 of 1 direct pop\(s\) migrated/);

    // 再扫一遍：已经干净
    const again = await pop(dir, ['fix', '--all']);
    expect(again.stdout).toMatch(/none carries v1 history fields/);
  });
});
