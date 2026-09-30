import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

// search：纯本地工作区检索。空查询=浏览 direct 根；JSON 形状 {query, results, total}。
describe('search: local workspace', () => {
  it('matches by substring and shows the short hash', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Kimchi stew', content: 'ferment cabbage' })])).stdout);

    const r = await pop(dir, ['search', 'kimchi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew');
    expect(r.stdout).toContain(root.slice('sha256:'.length, 'sha256:'.length + 12));
  });

  it('--json: results + total, no remote key', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Solo doc', content: 'x' })]);

    const r = await pop(dir, ['search', 'solo', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.results.length).toBe(1);
    expect(body.results[0].name).toBe('Solo doc');
    expect(body.total).toBe(1);
  });

  it('empty query = browse direct roots; no match says so', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Local only', content: 'needle' })]);

    const browse = await pop(dir, ['search']);
    expect(browse.code).toBe(0);
    expect(browse.stdout).toContain('Local only');

    const miss = await pop(dir, ['search', 'zzz-no-such']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toContain('no local matches');
    // 零命中不是死路：词法层对「换个说法」是结构性无能，提示要给出下一步动作
    expect(miss.stdout).toContain('--notes');
    expect(miss.stdout).toContain('practi similar');
  });
});

// P0-1：召回缺口——旧实现只从 direct 出发、只沿 children 递归，于是两类节点永远搜不到
describe('search: recalls every stored node (P0-1)', () => {
  it('finds a node referenced only by an action inputs.from (never a child of any tree)', async () => {
    const dir = tempDataDir();
    await init(dir);
    // B 先独立建树；A 的 action 用 from 指向 B 的根，B 不作为 A 的 children
    const b = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Zebra protocol root', content: 'outer doc' })])).stdout);
    await pop(dir, ['new', writeDoc(dir, {
      name: 'Alpha wrapper',
      content: 'wrapper doc',
      children: [
        { name: 'Consume zebra feed', content: 'consumes it', inputs: [{ name: 'zebra feed', from: b }] },
      ],
    })]);
    // B 撤出 direct：仍被 A 的 from 引用（GC 可达性沿 children + from），所以不会被删
    const rm = await pop(dir, ['remove', b]);
    expect(rm.code).toBe(0);

    const r = await pop(dir, ['search', 'Zebra', 'protocol']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Zebra protocol root');
    // 沿 inputs.from 可达 = 不是孤儿
    expect(r.stdout).not.toContain('orphan');
  });

  it('finds an orphan node (stored but never registered) and labels it as such', async () => {
    const dir = tempDataDir();
    await init(dir);
    // 附件指向不存在的 blob → 校验失败：节点落盘但**不登记**，于是成为孤儿
    const bad = await pop(dir, ['new', writeDoc(dir, {
      name: 'Orphan artifact doc',
      content: 'stored but never registered',
      attachments: [{ name: 'gone.png', hash: `sha256:${'a'.repeat(64)}` }],
    })]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/E_BLOB_MISSING/);

    const r = await pop(dir, ['search', 'Orphan', 'artifact']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Orphan artifact doc');
    expect(r.stdout).toContain('orphan (not reachable from any direct POP)');
  });
});

// P0-3：declared flows 进索引——「哪一步产出 boiling water」过去完全搜不到
describe('search: declared flows are indexed (P0-3)', () => {
  it('matches an action by an output name that appears nowhere else in the document', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, {
      name: 'Tea ceremony',
      content: 'the practice root',
      children: [
        { name: 'Heat the kettle', content: 'heat it up thoroughly', outputs: [{ name: 'boiling water', spec: '100°C' }] },
      ],
    })]);

    const r = await pop(dir, ['search', 'boiling water']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Heat the kettle');
    expect(r.stdout).toContain('flow');
  });
});

// P0-2：排序（title-first）+ 命中解释 + 稳定确定
describe('search: ranking and explanations (P0-2)', () => {
  it('ranks a name hit above a content hit', async () => {
    const dir = tempDataDir();
    await init(dir);
    // content 命中的先建，确保顺序不是靠插入顺序
    await pop(dir, ['new', writeDoc(dir, { name: 'Zzz other doc', content: 'needle lives in the body here' })]);
    await pop(dir, ['new', writeDoc(dir, { name: 'Needle topic', content: 'unrelated body' })]);

    const r = await pop(dir, ['search', 'needle']);
    expect(r.code).toBe(0);
    const nameAt = r.stdout.indexOf('Needle topic');
    const contentAt = r.stdout.indexOf('Zzz other doc');
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(contentAt).toBeGreaterThanOrEqual(0);
    expect(nameAt).toBeLessThan(contentAt);
    expect(r.stdout).toContain('← name');
  });

  it('--json carries score + matchedIn, and two runs are byte-identical', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Determinism probe', content: 'alpha beta gamma' })]);
    await pop(dir, ['new', writeDoc(dir, { name: 'Second probe', content: 'alpha only' })]);

    const first = await pop(dir, ['search', 'alpha', '--json']);
    const second = await pop(dir, ['search', 'alpha', '--json']);
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

// P1-1：多词 = AND（可跨字段），field: 限定
describe('search: multi-word AND and field qualifiers (P1-1)', () => {
  it('requires every word, and lets them match in different fields', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Alpha doc one', content: 'the beta marker lives here' })]);
    await pop(dir, ['new', writeDoc(dir, { name: 'Alpha doc two', content: 'gamma only' })]);

    const r = await pop(dir, ['search', 'alpha', 'beta']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Alpha doc one');
    expect(r.stdout).not.toContain('Alpha doc two');
  });

  it('name: restricts matching to the name field', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Quartz named doc', content: 'nothing here' })]);
    await pop(dir, ['new', writeDoc(dir, { name: 'Unrelated doc', content: 'quartz appears only in the body' })]);

    const r = await pop(dir, ['search', 'name:quartz']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Quartz named doc');
    expect(r.stdout).not.toContain('Unrelated doc');
  });

  it('relaxes only to a strict majority of terms, and marks each relaxed row', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'alpha doc', content: 'beta lives here' })]);

    // 三个词里对两个 → 放宽，并且逐行标出来（不能让它看起来像全中）
    const r = await pop(dir, ['search', 'alpha', 'beta', 'gamma']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('alpha doc');
    expect(r.stdout).toContain('relaxed');
    expect(r.stdout).toContain('partial match');

    // 两个词里只中一个 → 不过半：宁可不给，也不把无关记录当答案端出来
    const miss = await pop(dir, ['search', 'beta', 'zzzz-absent-word']);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toContain('no local matches');
  });
});

// P1-3：本地笔记纳入检索（默认关，--notes 开）——笔记里写着最口语、最可能被想起来的词
describe('search --notes (P1-3)', () => {
  it('finds a node by a word that appears only in its note, and leaves the default untouched', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Quiet practice', content: 'nothing to see' })])).stdout);
    const note = '实测踩坑 zzzmarker：先关掉浏览器再复制';
    expect((await pop(dir, ['note', 'add', root, '-m', note])).code).toBe(0);

    // 默认不索引笔记：既有命中集合不被改变
    const off = await pop(dir, ['search', 'zzzmarker']);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('no local matches');

    const on = await pop(dir, ['search', 'zzzmarker', '--notes']);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('Quiet practice');
    expect(on.stdout).toContain('note'); // 命中字段标注出来
  });

  it('keeps several notes on one node searchable together', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Two notes', content: 'body' })])).stdout);
    await pop(dir, ['note', 'add', root, '-m', 'first alpha-marker']);
    await pop(dir, ['note', 'add', root, '-m', 'second beta-marker']);

    for (const q of ['alpha-marker', 'beta-marker']) {
      const r = await pop(dir, ['search', q, '--notes']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Two notes');
    }
  });

  it('--json reports the note as the matched field', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Json note', content: 'body' })])).stdout);
    await pop(dir, ['note', 'add', root, '-m', 'jsonmarker here']);

    const r = await pop(dir, ['search', 'jsonmarker', '--notes', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.results[0].matchedIn).toContain('note');
  });
});
