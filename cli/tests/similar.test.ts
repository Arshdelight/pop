import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// similar：按内容找近邻（字面 bigram 相似度）。补的是中文「换个说法就搜不到」的短板。
describe('similar: content neighbours', () => {
  it('ranks a same-topic paraphrase above a merely-related node, and skips the target subtree', async () => {
    const dir = tempDataDir();
    await init(dir);
    // 目标：一棵树（根 + 子步骤）——根只有一句话，信息在子树里
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, {
      name: '配置目录复制',
      content: '把浏览器配置目录复制到新位置',
      children: [{ name: '定位配置目录', content: '先找到 user-data-dir 在哪里' }],
    })])).stdout);
    // 同一主题、换措辞
    const near = createdRoot((await pop(dir, ['new', writeDoc(dir, {
      name: '复制 user-data-dir',
      content: '把 user-data-dir 复制到新位置，先关掉浏览器',
    })])).stdout);
    // 只沾一个词
    const far = createdRoot((await pop(dir, ['new', writeDoc(dir, {
      name: '目录权限修复',
      content: 'chmod 修复目录权限问题',
    })])).stdout);

    const r = await pop(dir, ['similar', root, '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    const order: string[] = body.results.map((x: { hash: string }) => x.hash);
    expect(order).toContain(near);
    expect(order).toContain(far);
    expect(order.indexOf(near)).toBeLessThan(order.indexOf(far));
    const score = (h: string) => body.results.find((x: { hash: string }) => x.hash === h).score;
    expect(score(near)).toBeGreaterThan(score(far) * 2);

    // 目标自身与其子步骤不出现在结果里（它们本来就在目标的聚合文本中）
    expect(order).not.toContain(root);
    const view = JSON.parse((await pop(dir, ['show', root, '--json'])).stdout);
    for (const step of view.steps as { refHash: string }[]) {
      expect(order).not.toContain(step.refHash);
    }
  });

  it('lists shared terms so a human can judge why two records are neighbours', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: '配置目录复制', content: '把配置目录复制到新位置' })])).stdout);
    await pop(dir, ['new', writeDoc(dir, { name: '复制 user-data-dir', content: '复制配置目录到新位置' })]);

    const r = await pop(dir, ['similar', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('shared:');
    expect(r.stdout).toContain('复制');
    expect(r.stdout).toContain('similar node(s)');
  });

  it('--json is byte-identical across runs (deterministic)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Alpha topic', content: 'alpha body text' })])).stdout);
    await pop(dir, ['new', writeDoc(dir, { name: 'Beta topic', content: 'alpha body text two' })]);
    await pop(dir, ['new', writeDoc(dir, { name: 'Gamma other', content: 'unrelated words' })]);

    const first = await pop(dir, ['similar', root, '--json']);
    const second = await pop(dir, ['similar', root, '--json']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout).target.name).toBe('Alpha topic');
  });

  it('shows the score relative to the closest hit, and keeps the absolute ratio in --json', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: '配置目录复制', content: '把配置目录复制到新位置' })])).stdout);
    await pop(dir, ['new', writeDoc(dir, { name: '复制 user-data-dir', content: '把 user-data-dir 复制到新位置' })]);
    await pop(dir, ['new', writeDoc(dir, { name: '目录权限修复', content: 'chmod 修复目录权限' })]);

    const json = JSON.parse((await pop(dir, ['similar', root, '--json'])).stdout);
    expect(json.results[0].scorePct).toBe(100);
    expect(json.results[0].score).toBeGreaterThan(0);
    expect(json.results[0].score).toBeLessThanOrEqual(1);
    for (const r of json.results as { scorePct: number }[]) {
      expect(r.scorePct).toBeGreaterThan(0);
      expect(r.scorePct).toBeLessThanOrEqual(100);
    }

    const text = await pop(dir, ['similar', root]);
    expect(text.stdout).toContain('100%');
    expect(text.stdout).toContain('relative to the closest hit');
  });

  it('says so when nothing is close enough, and rejects an unknown hash', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: '泡菜做法', content: '白菜抹盐发酵三天' })])).stdout);
    await pop(dir, ['new', writeDoc(dir, { name: '配置目录复制', content: '把配置目录复制走' })]);

    // 与泡菜无任何共享措辞 → 空集（相似度不用单字，停用词不会造成假近邻）
    const none = await pop(dir, ['similar', root, '--json']);
    expect(none.code).toBe(0);
    expect(JSON.parse(none.stdout).results).toEqual([]);
    const text = await pop(dir, ['similar', root]);
    expect(text.stdout).toContain('no similar nodes');

    const ghost = await pop(dir, ['similar', 'f'.repeat(64)]);
    expect(ghost.code).toBe(1);
    expect(ghost.stderr).toContain('E_NOT_FOUND');

    const noArg = await pop(dir, ['similar']);
    expect(noArg.code).toBe(1);
  });
});
