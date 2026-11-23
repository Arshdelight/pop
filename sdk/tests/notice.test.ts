import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateView } from '../src/aggregate.js';
import { createFromDoc, parseDocument } from '../src/doc.js';
import { PracticeError } from '../src/errors.js';
import { exportSubtree } from '../src/export.js';
import { computeNodeHash } from '../src/hash.js';
import { parseNodeFromMatter, type ActionNode, type PNode, type PracticeNode } from '../src/model.js';
import { exportSkill, importSkill, SIDECAR_FILE, SKILL_FILE } from '../src/skill.js';
import { initWorkspace, loadWorkspace, saveNode } from '../src/store.js';
import { tempDir } from './helpers.js';

/**
 * POP 2.2.0 的两处演进（pop-spec §2 / §7 / 附录 A9）：
 *  - `notice`：每个节点可选的「注意事项 / 踩坑」字段，与 content 角色分开；参与哈希，纯空白 ≡ 缺省
 *  - 聚合视图派生的 externalInputs / finalOutputs：实践对外交换的清单，中间产物不在其中
 */

function action(name: string, extra: Partial<ActionNode> = {}): ActionNode {
  return { type: 'action', name, content: '', ...extra };
}

function practice(name: string, op: PracticeNode['op'], children: string[], extra: Partial<PracticeNode> = {}): PracticeNode {
  return { type: 'practice', name, content: '', op, children: children.map((h) => ({ hash: h })), ...extra };
}

function put(nodes: Map<string, PNode>, n: PNode): string {
  const h = computeNodeHash(n);
  nodes.set(h, n);
  return h;
}

describe('notice (POP 2.2.0)', () => {
  it('participates in the hash on both node types; whitespace-only ≡ absent — a node that never carried it keeps its identity', () => {
    const plain = action('Boil water', { content: 'Heat until boiling.' });
    const noted = { ...plain, notice: 'Do not overfill the kettle.' };
    expect(computeNodeHash(noted)).not.toBe(computeNodeHash(plain));
    expect(computeNodeHash({ ...plain, notice: '  \n ' })).toBe(computeNodeHash(plain));
    expect(computeNodeHash({ ...plain, notice: '' })).toBe(computeNodeHash(plain));
    // 同一句提醒写进 content 是另一个身份：角色不同，哈希必须能区分
    expect(computeNodeHash({ ...plain, content: 'Heat until boiling.\n\nDo not overfill the kettle.' })).not.toBe(computeNodeHash(noted));

    const child = action('Boil water', { content: 'Heat until boiling.' });
    const pPlain = practice('Make tea', 'seq', [computeNodeHash(child)]);
    const pNoted = { ...pPlain, notice: 'Watch the steam.' };
    expect(computeNodeHash(pNoted)).not.toBe(computeNodeHash(pPlain));
    expect(computeNodeHash({ ...pPlain, notice: ' ' })).toBe(computeNodeHash(pPlain));
  });

  it('document form: lands on the built node verbatim; blank is dropped; a non-string is E_SCHEMA naming the path', () => {
    const doc = parseDocument({
      name: 'Make tea', notice: ' Watch the steam. ', content: '',
      children: [{ name: 'Boil water', notice: 'Do not overfill.', content: 'Heat.' }],
    });
    expect(doc.root.notice).toBe(' Watch the steam. ');
    expect(doc.root.children[0].hash && doc.nodeHashes.get(doc.root.children[0].hash)!.notice).toBe('Do not overfill.');

    const blank = parseDocument({ name: 'Make tea', notice: '   ', content: 'c' });
    expect(blank.root.notice).toBeUndefined();
    expect('notice' in blank.root).toBe(false); // 空 ≡ 缺省：不物化空字段

    let err: unknown;
    try {
      parseDocument({ name: 'Make tea', notice: 42, content: 'c' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PracticeError);
    expect((err as PracticeError).code).toBe('E_SCHEMA');
    expect((err as PracticeError).message).toMatch(/\$\.notice must be a string when present/);
  });

  it('stored form: read back from the node file frontmatter; a non-string is E_SCHEMA', () => {
    const node = parseNodeFromMatter({ type: 'action', name: 'Boil water', notice: 'Do not overfill.' }, 'Heat until boiling.');
    expect(node).toEqual({ type: 'action', name: 'Boil water', notice: 'Do not overfill.', content: 'Heat until boiling.' });
    const pin = `sha256:${'a'.repeat(64)}`;
    expect(parseNodeFromMatter({ type: 'practice', name: 'Make tea', notice: 'Watch.', op: 'seq', children: [{ hash: pin }] }, '').notice).toBe('Watch.');
    expect(() => parseNodeFromMatter({ type: 'action', name: 'Boil water', notice: ['nope'] }, 'Heat.')).toThrowError(/notice must be a string/);
  });

  it('store round-trip: a multi-line notice survives nodeToMarkdown → loadWorkspace under the same hash', () => {
    const dir = tempDir();
    initWorkspace(dir);
    const node = action('Boil water', {
      description: 'Heat to boiling',
      notice: 'Do not overfill the kettle.\nUse cold water — hot tap water tastes flat.',
      content: 'Bring the water to a boil.',
    });
    const hash = saveNode(dir, node);
    expect(hash).toBe(computeNodeHash(node));
    const file = path.join(dir, 'nodes', `${hash.slice('sha256:'.length)}.md`);
    expect(fs.readFileSync(file, 'utf8')).toContain('notice:');
    const ws = loadWorkspace(dir);
    expect(ws.parseIssues).toEqual([]);
    expect(ws.nodes.get(hash)).toEqual(node);
  });

  it('export carries notice verbatim; a node without one exports without the key', () => {
    const nodes = new Map<string, PNode>();
    const childH = put(nodes, action('Boil water', { notice: 'Do not overfill.', content: 'Heat.' }));
    const rootH = put(nodes, practice('Make tea', 'seq', [childH], { notice: 'Watch the steam.' }));
    const doc = exportSubtree(nodes.get(rootH)!, nodes) as Record<string, unknown>;
    expect(doc.notice).toBe('Watch the steam.');
    expect((doc.children as Record<string, unknown>[])[0].notice).toBe('Do not overfill.');

    const bare = exportSubtree(action('Pour', { content: 'Pour.' }), new Map()) as Record<string, unknown>;
    expect('notice' in bare).toBe(false);
  });

  it('skill export projects notice as a blockquote, and the sidecar still replays byte-identically', () => {
    const wsDir = tempDir();
    initWorkspace(wsDir);
    const { root } = createFromDoc(loadWorkspace(wsDir), {
      type: 'practice', name: 'Make tea', notice: 'Watch the steam.', op: 'seq',
      children: [{ type: 'action', name: 'Boil water', notice: 'Do not overfill the kettle.', content: 'Heat until boiling.' }],
    });

    const outDir = tempDir();
    const res = exportSkill(loadWorkspace(wsDir), root, outDir);
    const md = fs.readFileSync(path.join(outDir, SKILL_FILE), 'utf8');
    expect(md).toContain('> **Notice:** Watch the steam.');
    expect(md).toContain('> **Notice:** Do not overfill the kettle.');
    // 提醒垫底：排在本节点自己的正文之后、子节点小节之前
    expect(md.indexOf('> **Notice:** Do not overfill the kettle.')).toBeGreaterThan(md.indexOf('Heat until boiling.'));
    expect(md.indexOf('## Boil water')).toBeGreaterThan(md.indexOf('Watch the steam.'));
    expect(res.files).toEqual([]);

    const wsDir2 = tempDir();
    initWorkspace(wsDir2);
    const back = importSkill(loadWorkspace(wsDir2), outDir);
    expect(back.sidecarUsed).toBe(true);
    expect(back.drift).toBe(false);
    expect(back.root).toBe(root);
    const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, SIDECAR_FILE), 'utf8')) as { notice?: string };
    expect(sidecar.notice).toBe('Watch the steam.');
  });
});

describe('external inputs / final outputs (§7, POP 2.2.0)', () => {
  it('only what crosses the practice boundary: supplied needs and consumed products are neither', () => {
    const nodes = new Map<string, PNode>();
    const boilH = put(nodes, action('Boil water', {
      inputs: [{ name: 'kettle' }], // 外部：工具
      outputs: [{ name: 'boiling water', spec: '100°C' }],
    }));
    const pourH = put(nodes, action('Pour', {
      inputs: [{ name: 'boiling water', from: boilH }, { name: 'tea leaves', spec: '2 g' }], // 一个被上游供给，一个外部
      outputs: [{ name: 'cup of tea', spec: '85°C' }],
    }));
    const p = put(nodes, practice('Make tea', 'seq', [boilH, pourH]));
    const v = aggregateView(p, nodes);
    expect(v.externalInputs).toEqual([
      { name: 'kettle', refHash: boilH },
      { name: 'tea leaves', spec: '2 g', refHash: pourH },
    ]);
    expect(v.finalOutputs).toEqual([{ name: 'cup of tea', spec: '85°C', refHash: pourH }]);
  });

  it('reading a sub-practice: a need supplied by a step OUTSIDE the subtree is external — its product must be brought in', () => {
    // 用户 2026-11-24 发现的缺陷（「按周训练」的需要准备漏了「基线结果」）：基线测试在「按周训练」外面，
    // 它的产出对这一节来说是要从外面带进来的东西
    const nodes = new Map<string, PNode>();
    const baseH = put(nodes, action('Baseline test', { outputs: [{ name: 'baseline result' }] }));
    const runH = put(nodes, action('Run three times', {
      inputs: [{ name: 'shoes' }, { name: 'baseline result', from: baseH }],
      outputs: [{ name: 'week of running' }],
    }));
    const assessH = put(nodes, action('Assess', {
      inputs: [{ name: 'week of running', from: runH }],
      outputs: [{ name: 'next plan' }],
    }));
    const weekH = put(nodes, practice('Train by week', 'loop', [runH, assessH]));
    const week = aggregateView(weekH, nodes);
    expect(week.externalInputs).toEqual([
      { name: 'shoes', refHash: runH },
      { name: 'baseline result', refHash: runH },
    ]);
    expect(week.finalOutputs).toEqual([{ name: 'next plan', refHash: assessH }]);
    // 整篇读：基线结果与一周的跑步都是中间产物，两边都不列
    const whole = aggregateView(put(nodes, practice('First 5k', 'seq', [baseH, weekH])), nodes);
    expect(whole.externalInputs.map((d) => d.name)).toEqual(['shoes']);
    expect(whole.finalOutputs.map((d) => d.name)).toEqual(['next plan']);
    // 只读评估这一步所在的小节：它消费的「一周的跑步」同样来自外面
    const tail = aggregateView(put(nodes, practice('Weekend', 'seq', [assessH])), nodes);
    expect(tail.externalInputs.map((d) => d.name)).toEqual(['week of running']);
  });

  it('a wired flow whose input name differs from the output name still counts when the wired node declares a single flow (Appendix A2 shape)', () => {
    const nodes = new Map<string, PNode>();
    const boilH = put(nodes, action('Boil water', { outputs: [{ name: 'boiling water', spec: '100°C' }] }));
    const pourH = put(nodes, action('Pour', {
      inputs: [{ name: 'hot water', from: boilH }],
      outputs: [{ name: 'cup of tea', spec: '85°C' }],
    }));
    const v = aggregateView(put(nodes, practice('Make tea', 'seq', [boilH, pourH])), nodes);
    expect(v.externalInputs).toEqual([]);
    expect(v.finalOutputs).toEqual([{ name: 'cup of tea', spec: '85°C', refHash: pourH }]);
  });

  it('a multi-flow node is matched by name only — an edge naming none of its outputs swallows nothing', () => {
    const nodes = new Map<string, PNode>();
    const boilH = put(nodes, action('Boil water', { outputs: [{ name: 'boiling water' }, { name: 'steam' }] }));
    const pourH = put(nodes, action('Pour', { inputs: [{ name: 'hot water', from: boilH }] }));
    const v = aggregateView(put(nodes, practice('Make tea', 'seq', [boilH, pourH])), nodes);
    // 生产方有两个产出、边的名字对不上任何一个：无法判定消费的是哪个 → 都保留在最终产出里（保守）
    expect(v.finalOutputs.map((d) => d.name)).toEqual(['boiling water', 'steam']);
    // 消费方只声明了一个需求：这条边必然供给它
    expect(v.externalInputs).toEqual([]);
  });

  it('a practice with no flows at all has empty lists; a set op aggregates nothing', () => {
    const nodes = new Map<string, PNode>();
    const soloH = put(nodes, action('Only step', { content: 'x' }));
    expect(aggregateView(put(nodes, practice('Solo', 'seq', [soloH])), nodes)).toMatchObject({ externalInputs: [], finalOutputs: [] });

    const aH = put(nodes, action('A', { inputs: [{ name: 'thing' }], outputs: [{ name: 'other' }] }));
    expect(aggregateView(put(nodes, practice('Collection', 'set', [aH])), nodes)).toMatchObject({ externalInputs: [], finalOutputs: [] });
  });

  it('action view: every input is external and every output final (nothing inside a leaf can supply or consume)', () => {
    const nodes = new Map<string, PNode>();
    // 供给方在工作区里存在也罢、指向一个不存在的节点也罢——对一个叶子来说它都在外面
    const boilH = put(nodes, action('Boil water', { outputs: [{ name: 'boiling water' }] }));
    const h = put(nodes, action('Pour', {
      inputs: [{ name: 'boiling water', from: boilH }, { name: 'hot water', from: `sha256:${'a'.repeat(64)}` }, { name: 'cup' }],
      outputs: [{ name: 'cup of tea' }],
    }));
    const v = aggregateView(h, nodes);
    expect(v.externalInputs).toEqual([
      { name: 'boiling water', refHash: h },
      { name: 'hot water', refHash: h },
      { name: 'cup', refHash: h },
    ]);
    expect(v.finalOutputs).toEqual([{ name: 'cup of tea', refHash: h }]);
  });

  it('notice rides along: the read root on the view, each action on its step entry — carried even without --full', () => {
    const nodes = new Map<string, PNode>();
    const boilH = put(nodes, action('Boil water', { notice: 'Do not overfill.', content: 'Heat.' }));
    const rootH = put(nodes, practice('Make tea', 'seq', [boilH], { notice: 'Watch the steam.' }));
    const v = aggregateView(rootH, nodes);
    expect(v.notice).toBe('Watch the steam.');
    expect(v.steps[0].notice).toBe('Do not overfill.');
    expect(v.steps[0].content).toBeUndefined(); // 没传 full：正文不进骨架，提醒进
  });
});
