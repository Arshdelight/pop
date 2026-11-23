import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspace } from '@arshdelight/pop-sdk';
import { chainOf, freePort, init, runIn, spawnWeb, tempDataDir, untilHealthy, writeDoc } from './helpers.js';

const TREE = {
  name: 'Make tea',
  description: 'From kettle to cup',
  children: [
    { name: 'Boil water', content: 'Heat the drinking water to boiling.' },
    { name: 'Pour', content: 'Pour along the wall to 70% full.' },
  ],
};

/** 带首版修订的实例文件夹（TREE 为主体） */
async function setup(name = 'make-tea'): Promise<{ home: string; repo: string; root: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  const file = writeDoc(parent, 'seed.json', TREE);
  await runIn(parent, home, ['new', name, '--base', file]);
  const repo = path.join(parent, name);
  return { home, repo, root: chainOf(repo).commits[0]!.root };
}

describe('pop show: hash addressing (full hash and unique prefix)', () => {
  it('by full hash: renders the aggregate view with the derived steps', async () => {
    const { home, repo, root } = await setup();
    const r = await runIn(repo, home, ['show', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Make tea');
    expect(r.stdout).toContain('Boil water');
    expect(r.stdout).toContain('steps:');

    const json = await runIn(repo, home, ['show', root, '--json']);
    expect(json.code).toBe(0);
    const view = JSON.parse(json.stdout);
    // the StandardView is the machine-readable form (hash identity + derived steps)
    expect(view.hash).toBe(root);
    expect(view.type).toBe('practice');
    expect(view.name).toBe('Make tea');
    expect(view.steps.map((s: { name: string }) => s.name)).toEqual(['Boil water', 'Pour']);
    // --json is the full reproduction view: each step carries its content (one read, no per-step re-query)
    expect(view.steps[0].content).toBe('Heat the drinking water to boiling.');
  });

  it('by unique short prefix: resolves to the same node (there are no local names)', async () => {
    const { home, repo, root } = await setup();
    const prefix = root.slice('sha256:'.length, 'sha256:'.length + 10);

    const byFull = await runIn(repo, home, ['show', root]);
    const byPrefix = await runIn(repo, home, ['show', prefix]);
    expect(byPrefix.code).toBe(0);
    // prefix resolution addresses the identical node → identical output
    expect(byPrefix.stdout).toBe(byFull.stdout);
  });

  it('--doc prints the document form (the authoring JSON round-trip channel)', async () => {
    const { home, repo, root } = await setup();
    const r = await runIn(repo, home, ['show', root, '--doc']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.name).toBe('Make tea');
    expect(doc.children).toHaveLength(2);
    expect(doc.children[1]).toMatchObject({ name: 'Pour' });
  });

  it('an unknown hash → typed E_NOT_FOUND, nonzero exit', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['show', `sha256:${'0'.repeat(64)}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error \[E_NOT_FOUND\]/);
  });
});

// 哈希纪律（第 4 点）：本地「没找到」先区分「找到但哈希不正确」（加载层 E_NODE_CORRUPT）
// 与「从未存在」。
describe('show: found-but-hash-mismatch is an error, never silent', () => {
  it('a hand-edited node file reports corruption, not plain not-found', async () => {
    const { home, repo, root } = await setup();
    const file = path.join(repo, '.practi', 'nodes', `${root.slice('sha256:'.length)}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('kettle to cup', 'tampered cup'));

    const r = await runIn(repo, home, ['show', root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_NODE_CORRUPT');
    expect(r.stderr).toContain('the node file exists locally');
    expect(r.stderr).toContain('hashes to sha256:'); // 名实不符的实算值
  });

  it('a prefix that matches nothing is a local-only E_NOT_FOUND (no network)', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['show', 'abcdef12']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_NOT_FOUND');
    expect(r.stderr).toContain('prefixes resolve only locally');
  });

  it('a full hash missing locally is E_NOT_FOUND (offline by construction)', async () => {
    const { home, repo } = await setup();
    const ghost = `sha256:${'c'.repeat(64)}`;
    const r = await runIn(repo, home, ['show', ghost]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_NOT_FOUND');
    expect(r.stderr).toContain('not in the local workspace');
  });

  it('local happy path unchanged: found node renders as before', async () => {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const file = writeDoc(parent, 'seed.json', { name: 'Plain', content: 'fine' });
    await runIn(parent, home, ['new', 'plain-p', '--base', file]);
    const repo = path.join(parent, 'plain-p');
    const root = chainOf(repo).commits[0]!.root;
    const r = await runIn(repo, home, ['show', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Plain');
  });
});

// spec 2.2.0：notice 与派生的对外清单。照着做的人 / agent 读的是 `show`——提醒、要备什么、
// 得到什么必须都在这份输出里，作者才能不必在正文里复述
describe('show: notice and the derived external-input / final-output lists (spec 2.2.0)', () => {
  const FLOWS = {
    name: 'Make tea',
    description: 'From kettle to cup',
    notice: 'Keep the kettle half-full at most.',
    children: [
      {
        name: 'Boil water',
        description: 'Heat the water to a rolling boil.',
        notice: 'Do not overfill the kettle.',
        content: 'Fill the kettle with drinking water and switch it on.',
        inputs: [{ name: 'kettle' }],
        outputs: [{ name: 'boiling water', spec: '100°C' }],
      },
      {
        name: 'Pour',
        description: 'Fill the cup.',
        content: 'Pour along the wall.',
        inputs: [{ name: 'boiling water', from: '@Boil water' }, { name: 'tea leaves', spec: '2 g' }],
        outputs: [{ name: 'cup of tea', spec: '85°C' }],
      },
    ],
  };

  async function setupFlows(): Promise<{ home: string; repo: string; root: string }> {
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const file = writeDoc(parent, 'seed.json', FLOWS);
    await runIn(parent, home, ['new', 'tea-flows', '--base', file]);
    const repo = path.join(parent, 'tea-flows');
    return { home, repo, root: chainOf(repo).commits[0]!.root };
  }

  it('human output: both notices, and only the flows that cross the practice boundary', async () => {
    const { home, repo, root } = await setupFlows();
    const r = await runIn(repo, home, ['show', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('notice: Keep the kettle half-full at most.');
    // 提醒垫底：节点的各节都打完才轮到它（与 practi web 阅读器同序）
    const noticeAt = r.stdout.indexOf('notice: Keep the kettle half-full at most.');
    expect(noticeAt).toBeGreaterThan(r.stdout.indexOf('steps:'));
    expect(noticeAt).toBeGreaterThan(r.stdout.indexOf('final outputs'));
    expect(noticeAt).toBeGreaterThan(r.stdout.indexOf('declared outputs'));
    expect(r.stdout).toMatch(/Boil water[^\n]*\n[^\n]*⚠ Do not overfill the kettle\./);
    expect(r.stdout).toContain('external inputs (prepare these outside the practice):');
    const external = r.stdout.slice(r.stdout.indexOf('external inputs'), r.stdout.indexOf('final outputs'));
    expect(external).toContain('kettle');
    expect(external).toContain('tea leaves — 2 g');
    expect(external).not.toContain('boiling water'); // 上游供给的中间需求不算「要备的」
    const finals = r.stdout.slice(r.stdout.indexOf('final outputs'), r.stdout.indexOf('declared inputs'));
    expect(finals).toContain('cup of tea — 85°C');
    expect(finals).not.toContain('boiling water'); // 被下游消费的中间产物不算「得到的」
    expect(r.stdout).toContain('declared outputs (produces):'); // 声明全表照旧，派生清单是另一对
  });

  it('--json: notice on the view and on each step, plus the two derived lists', async () => {
    const { home, repo, root } = await setupFlows();
    const r = await runIn(repo, home, ['show', root, '--json']);
    expect(r.code).toBe(0);
    const view = JSON.parse(r.stdout) as {
      notice?: string;
      steps: { name: string; notice?: string }[];
      externalInputs: { name: string; spec?: string }[];
      finalOutputs: { name: string; spec?: string }[];
    };
    expect(view.notice).toBe('Keep the kettle half-full at most.');
    expect(view.steps.map((s) => `${s.name}:${s.notice ?? ''}`)).toEqual(['Boil water:Do not overfill the kettle.', 'Pour:']);
    expect(view.externalInputs.map((d) => `${d.name}${d.spec ? ` — ${d.spec}` : ''}`)).toEqual(['kettle', 'tea leaves — 2 g']);
    expect(view.finalOutputs.map((d) => `${d.name}${d.spec ? ` — ${d.spec}` : ''}`)).toEqual(['cup of tea — 85°C']);
  });

  it('a sub-practice read on its own lists a need supplied from OUTSIDE it (show + practi web agree)', async () => {
    // 用户 2026-11-24 发现的缺陷：基线测试在「按周训练」外面，它供给的「基线结果」曾被当成内部中间产物，
    // 从这一节的「要备的」里漏掉——整篇读时两边都不列才是对的
    const home = tempDataDir();
    await init(home);
    const parent = tempDataDir();
    const file = writeDoc(parent, 'nested.json', {
      name: 'First 5k',
      children: [
        { name: 'Baseline test', content: 'Walk fast for 30 minutes and note how it feels.', outputs: [{ name: 'baseline result' }] },
        {
          name: 'Train by week',
          children: [
            {
              name: 'Run three times',
              content: 'Run three times this week at an easy pace.',
              inputs: [{ name: 'shoes' }, { name: 'baseline result', from: '@Baseline test' }],
              outputs: [{ name: 'week of running' }],
            },
          ],
        },
      ],
    });
    await runIn(parent, home, ['new', 'nested', '--base', file]);
    const repo = path.join(parent, 'nested');
    const root = chainOf(repo).commits[0]!.root;
    const rootNode = loadWorkspace(path.join(repo, '.practi')).nodes.get(root)! as { children: { hash: string }[] };
    const week = rootNode.children[1]!.hash;

    const externalOf = (stdout: string): string[] => {
      const block = stdout.slice(stdout.indexOf('external inputs'), stdout.indexOf('final outputs'));
      return block.split('\n').slice(1).map((l) => l.trim().replace(/\s+\[[0-9a-f]+\]$/, '')).filter(Boolean);
    };
    const sub = await runIn(repo, home, ['show', week]);
    expect(sub.code, sub.stderr).toBe(0);
    expect(externalOf(sub.stdout)).toEqual(['shoes', 'baseline result']);
    const whole = await runIn(repo, home, ['show', root]);
    expect(whole.code, whole.stderr).toBe(0);
    expect(externalOf(whole.stdout)).toEqual(['shoes']);

    const port = await freePort();
    const child = spawnWeb(repo, home, port);
    try {
      const base = await untilHealthy(port, child);
      const view = (await (await fetch(`${base}/pop/${encodeURIComponent(week)}.json`)).json()) as {
        externalInputs: { name: string; refHash: string }[];
      };
      expect(view.externalInputs.map((d) => d.name)).toEqual(['shoes', 'baseline result']);
    } finally {
      child.kill();
    }
  });

  it('--doc: notice round-trips verbatim through the authoring channel', async () => {
    const { home, repo, root } = await setupFlows();
    const r = await runIn(repo, home, ['show', root, '--doc']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as { notice?: string; children: { notice?: string }[] };
    expect(doc.notice).toBe('Keep the kettle half-full at most.');
    expect(doc.children[0].notice).toBe('Do not overfill the kettle.');
    expect('notice' in doc.children[1]).toBe(false);
  });

  it('practi web serves the same derived lists on /pop/<hash>.json (the wizard renders them on practice pages)', async () => {
    const { home, repo, root } = await setupFlows();
    const port = await freePort();
    const child = spawnWeb(repo, home, port);
    try {
      const base = await untilHealthy(port, child);
      const view = (await (await fetch(`${base}/pop/${encodeURIComponent(root)}.json`)).json()) as {
        notice?: string;
        steps: { refHash: string; name: string }[];
        externalInputs: { name: string }[];
        finalOutputs: { name: string }[];
      };
      expect(view.notice).toBe('Keep the kettle half-full at most.');
      expect(view.externalInputs.map((d) => d.name)).toEqual(['kettle', 'tea leaves']);
      expect(view.finalOutputs.map((d) => d.name)).toEqual(['cup of tea']);

      // 哈希登记簿记的是节点的真实哈希：/doc 导出态把 subtree 内的 from 改写成 "@名字"，对着
      // 导出态重算的哈希不是节点身份——带 from 的步骤（这里是 Pour）曾经因此全部登记不上
      const docView = (await (await fetch(`${base}/doc/${encodeURIComponent(root)}.json`)).json()) as {
        nodeIndex: Record<string, number[]>;
        children: { inputs?: { from?: string }[] }[];
      };
      expect(docView.children[1].inputs?.[0].from).toBe('@Boil water'); // 导出态确实是标签写法
      for (const s of view.steps) expect(docView.nodeIndex[s.refHash], s.name).toBeDefined();
      expect(docView.nodeIndex[view.steps[0].refHash]).toEqual([0]);
      expect(docView.nodeIndex[view.steps[1].refHash]).toEqual([1]);
    } finally {
      child.kill();
    }
  });
});
