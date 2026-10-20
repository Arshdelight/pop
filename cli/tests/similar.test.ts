import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc, workingFile } from './helpers.js';

// similar：按内容找近邻（字面 bigram 相似度）。补的是中文「换个说法就搜不到」的短板。
// 文件夹模型下搜索对象=本实例池：多篇文档以修订史共存于一个实例（v1/v2/v3），
// 池里全部节点都是候选（历史修订一样参与近邻）。

const T1 = {
  name: '配置目录复制',
  content: '把浏览器配置目录复制到新位置',
  children: [{ name: '定位配置目录', content: '先找到 user-data-dir 在哪里' }],
};
const T2 = { name: '复制 user-data-dir', content: '把 user-data-dir 复制到新位置，先关掉浏览器' };
const T3 = { name: '目录权限修复', content: 'chmod 修复目录权限问题' };

/** 带多篇修订的实例文件夹：docs 依次成为 v1、v2…… */
async function setup(...docs: Record<string, unknown>[]): Promise<{ home: string; repo: string; roots: string[] }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  const [first, ...rest] = docs;
  await runIn(parent, home, ['new', 'similar-p', '--base', writeDoc(parent, 'v1.json', first)]);
  const repo = path.join(parent, 'similar-p');
  const roots = [chainOf(repo).commits[0]!.root];
  for (let i = 0; i < rest.length; i++) {
    fs.writeFileSync(workingFile(repo), JSON.stringify(rest[i], null, 2) + '\n', 'utf8');
    const c = await runIn(repo, home, ['commit', '-m', `v${i + 2}`]);
    if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);
    roots.push(chainOf(repo).branches.main!);
  }
  return { home, repo, roots };
}

describe('similar: content neighbours', () => {
  it('ranks a same-topic paraphrase above a merely-related node, and skips the target subtree', async () => {
    const { home, repo, roots } = await setup(T1, T2, T3);
    const [root, near, far] = roots; // v1=目标树、v2=近邻、v3=只沾一个词

    const r = await runIn(repo, home, ['similar', root, '--json']);
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
    const view = JSON.parse((await runIn(repo, home, ['show', root, '--json'])).stdout);
    for (const step of view.steps as { refHash: string }[]) {
      expect(order).not.toContain(step.refHash);
    }
  });

  it('lists shared terms so a human can judge why two records are neighbours', async () => {
    const { home, repo, roots } = await setup(
      { name: '配置目录复制', content: '把配置目录复制到新位置' },
      { name: '复制 user-data-dir', content: '复制配置目录到新位置' },
    );

    const r = await runIn(repo, home, ['similar', roots[0]]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('shared:');
    expect(r.stdout).toContain('复制');
    expect(r.stdout).toContain('similar node(s)');
  });

  it('--json is byte-identical across runs (deterministic)', async () => {
    const { home, repo, roots } = await setup(
      { name: 'Alpha topic', content: 'alpha body text' },
      { name: 'Beta topic', content: 'alpha body text two' },
      { name: 'Gamma other', content: 'unrelated words' },
    );

    const first = await runIn(repo, home, ['similar', roots[0], '--json']);
    const second = await runIn(repo, home, ['similar', roots[0], '--json']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout).target.name).toBe('Alpha topic');
  });

  it('shows the score relative to the closest hit, and keeps the absolute ratio in --json', async () => {
    const { home, repo, roots } = await setup(
      { name: '配置目录复制', content: '把配置目录复制到新位置' },
      { name: '复制 user-data-dir', content: '把 user-data-dir 复制到新位置' },
      { name: '目录权限修复', content: 'chmod 修复目录权限' },
    );

    const json = JSON.parse((await runIn(repo, home, ['similar', roots[0], '--json'])).stdout);
    expect(json.results[0].scorePct).toBe(100);
    expect(json.results[0].score).toBeGreaterThan(0);
    expect(json.results[0].score).toBeLessThanOrEqual(1);
    for (const r of json.results as { scorePct: number }[]) {
      expect(r.scorePct).toBeGreaterThan(0);
      expect(r.scorePct).toBeLessThanOrEqual(100);
    }

    const text = await runIn(repo, home, ['similar', roots[0]]);
    expect(text.stdout).toContain('100%');
    expect(text.stdout).toContain('relative to the closest hit');
  });

  it('says so when nothing is close enough, and rejects an unknown hash', async () => {
    const { home, repo, roots } = await setup(
      { name: '泡菜做法', content: '白菜抹盐发酵三天' },
      { name: '配置目录复制', content: '把配置目录复制走' },
    );

    // 与泡菜无任何共享措辞 → 空集（相似度不用单字，停用词不会造成假近邻）
    const none = await runIn(repo, home, ['similar', roots[0], '--json']);
    expect(none.code).toBe(0);
    expect(JSON.parse(none.stdout).results).toEqual([]);
    const text = await runIn(repo, home, ['similar', roots[0]]);
    expect(text.stdout).toContain('no similar nodes');

    const ghost = await runIn(repo, home, ['similar', 'f'.repeat(64)]);
    expect(ghost.code).toBe(1);
    expect(ghost.stderr).toContain('E_NOT_FOUND');

    const noArg = await runIn(repo, home, ['similar']);
    expect(noArg.code).toBe(1);
  });
});
