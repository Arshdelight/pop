import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc, workingFile } from './helpers.js';

// search：本实例内容池检索。空查询=浏览当前支头；JSON 形状 {query, mode, results, total}；
// 池里全部节点都是候选——历史修订的内容一样可搜（检索对象不再有 direct/orphan 之分）。

const SHORT = (h: string) => h.slice('sha256:'.length, 'sha256:'.length + 12);

/** 带首版修订的实例文件夹 */
async function setup(doc: Record<string, unknown>, name = 'my-practice'): Promise<{ home: string; repo: string; root: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  await runIn(parent, home, ['new', name, '--base', writeDoc(parent, 'seed.json', doc)]);
  const repo = path.join(parent, name);
  return { home, repo, root: chainOf(repo).commits[0]!.root };
}

/** 在既有实例上追加一版修订（改工作文件 → commit） */
async function commitDoc(home: string, repo: string, doc: Record<string, unknown>, message: string): Promise<string> {
  fs.writeFileSync(workingFile(repo), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const c = await runIn(repo, home, ['commit', '-m', message]);
  if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);
  return chainOf(repo).branches.main!;
}

describe('search: this instance\'s pool', () => {
  it('matches by substring and shows the short hash', async () => {
    const { home, repo, root } = await setup({ name: 'Kimchi stew', content: 'ferment cabbage' });

    const r = await runIn(repo, home, ['search', 'kimchi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew');
    expect(r.stdout).toContain(SHORT(root));
  });

  it('--json: results + total, no remote key', async () => {
    const { home, repo } = await setup({ name: 'Solo doc', content: 'x' });

    const r = await runIn(repo, home, ['search', 'solo', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.results.length).toBe(1);
    expect(body.results[0].name).toBe('Solo doc');
    expect(body.total).toBe(1);
  });

  it('empty query = browse the head document; no match says so', async () => {
    const { home, repo } = await setup({ name: 'Local only', content: 'needle' });

    const browse = await runIn(repo, home, ['search']);
    expect(browse.code).toBe(0);
    expect(browse.stdout).toContain('Local only');
    expect(browse.stdout).toContain('current head of');

    const miss = await runIn(repo, home, ['search', 'zzz-no-such']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toContain('no local matches');
    // 零命中不是死路：词法层对「换个说法」是结构性无能，提示要给出下一步动作
    expect(miss.stdout).toContain('--notes');
    expect(miss.stdout).toContain('practi similar');
  });
});

// 池=全部历史内容：被新修订换下去的节点仍可搜（内容寻址落盘，一样是这个实例的记忆）
describe('search: recalls every stored revision', () => {
  it('finds a node that a later commit replaced (still in the pool)', async () => {
    const { home, repo } = await setup({ name: 'Zebra protocol root', content: 'outer doc about zebras' });
    await commitDoc(home, repo, { name: 'Replacement topic', content: 'a brand new body' }, 'replace the zebra doc');

    const r = await runIn(repo, home, ['search', 'zebra']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Zebra protocol root');
    expect(r.stdout).not.toContain('Replacement topic');
  });
});

// declared flows 进索引——「哪一步产出 boiling water」完全靠它搜得到
describe('search: declared flows are indexed', () => {
  it('matches an action by an output name that appears nowhere else in the document', async () => {
    const { home, repo } = await setup({
      name: 'Tea ceremony',
      content: 'the practice root',
      children: [
        { name: 'Heat the kettle', content: 'heat it up thoroughly', outputs: [{ name: 'boiling water', spec: '100°C' }] },
      ],
    });

    const r = await runIn(repo, home, ['search', 'boiling water']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Heat the kettle');
    expect(r.stdout).toContain('← flow');
  });
});

// 排序（title-first）+ 命中解释 + 稳定确定
describe('search: ranking and explanations', () => {
  it('ranks a name hit above a content hit', async () => {
    const { home, repo } = await setup({ name: 'Zzz other doc', content: 'needle lives in the body here' });
    // content 命中的先建（v1），name 命中的后提交（v2），排除插入顺序的影响
    await commitDoc(home, repo, { name: 'Needle topic', content: 'unrelated body' }, 'v2');

    const r = await runIn(repo, home, ['search', 'needle']);
    expect(r.code).toBe(0);
    const nameAt = r.stdout.indexOf('Needle topic');
    const contentAt = r.stdout.indexOf('Zzz other doc');
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(contentAt).toBeGreaterThanOrEqual(0);
    expect(nameAt).toBeLessThan(contentAt);
    expect(r.stdout).toContain('← name');
  });

  it('--json carries score + matchedIn, and two runs are byte-identical', async () => {
    const { home, repo } = await setup({ name: 'Determinism probe', content: 'alpha beta gamma' });
    await commitDoc(home, repo, { name: 'Second probe', content: 'alpha only' }, 'v2');

    const first = await runIn(repo, home, ['search', 'alpha', '--json']);
    const second = await runIn(repo, home, ['search', 'alpha', '--json']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    const body = JSON.parse(first.stdout);
    expect(body.total).toBe(2);
    expect(typeof body.results[0].score).toBe('number');
    expect(body.results[0].score).toBeGreaterThan(0);
    expect(Array.isArray(body.results[0].matchedIn)).toBe(true);
    expect(body.results[0].matchedIn).toContain('content');
  });
});

// 多词 = AND（可跨字段），field: 限定
describe('search: multi-word AND and field qualifiers', () => {
  it('requires every word, and lets them match in different fields', async () => {
    const { home, repo } = await setup({ name: 'Alpha doc one', content: 'the beta marker lives here' });
    await commitDoc(home, repo, { name: 'Alpha doc two', content: 'gamma only' }, 'v2');

    const r = await runIn(repo, home, ['search', 'alpha', 'beta']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Alpha doc one');
    expect(r.stdout).not.toContain('Alpha doc two');
  });

  it('name: restricts matching to the name field', async () => {
    const { home, repo } = await setup({ name: 'Quartz named doc', content: 'nothing here' });
    await commitDoc(home, repo, { name: 'Unrelated doc', content: 'quartz appears only in the body' }, 'v2');

    const r = await runIn(repo, home, ['search', 'name:quartz']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Quartz named doc');
    expect(r.stdout).not.toContain('Unrelated doc');
  });

  it('relaxes only to a strict majority of terms, and marks each relaxed row', async () => {
    const { home, repo } = await setup({ name: 'alpha doc', content: 'beta lives here' });

    // 三个词里对两个 → 放宽，并且逐行标出来（不能让它看起来像全中）
    const r = await runIn(repo, home, ['search', 'alpha', 'beta', 'gamma']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('alpha doc');
    expect(r.stdout).toContain('relaxed');
    expect(r.stdout).toContain('partial match');

    // 两个词里只中一个 → 不过半：宁可不给，也不把无关记录当答案端出来
    const miss = await runIn(repo, home, ['search', 'beta', 'zzzz-absent-word']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toContain('no local matches');
  });
});

// 本地笔记纳入检索（默认关，--notes 开）——笔记里写着最口语、最可能被想起来的词
describe('search --notes', () => {
  it('finds a node by a word that appears only in its note, and leaves the default untouched', async () => {
    const { home, repo, root } = await setup({ name: 'Quiet practice', content: 'nothing to see' });
    const note = '实测踩坑 zzzmarker：先关掉浏览器再复制';
    expect((await runIn(repo, home, ['note', 'add', root, '-m', note])).code).toBe(0);

    // 默认不索引笔记：既有命中集合不被改变
    const off = await runIn(repo, home, ['search', 'zzzmarker']);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('no local matches');

    const on = await runIn(repo, home, ['search', 'zzzmarker', '--notes']);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('Quiet practice');
    expect(on.stdout).toContain('← note'); // 命中字段标注出来
  });

  it('keeps several notes on one node searchable together', async () => {
    const { home, repo, root } = await setup({ name: 'Two notes', content: 'body' });
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'first alpha-marker'])).code).toBe(0);
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'second beta-marker'])).code).toBe(0);

    for (const q of ['alpha-marker', 'beta-marker']) {
      const r = await runIn(repo, home, ['search', q, '--notes']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Two notes');
    }
  });

  it('--json reports the note as the matched field', async () => {
    const { home, repo, root } = await setup({ name: 'Json note', content: 'body' });
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'jsonmarker here'])).code).toBe(0);

    const r = await runIn(repo, home, ['search', 'jsonmarker', '--notes', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.results[0].matchedIn).toContain('note');
  });
});
