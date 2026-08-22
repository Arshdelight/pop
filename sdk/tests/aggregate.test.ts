import { describe, expect, it } from 'vitest';
import { aggregateView } from '../src/aggregate.js';
import { computeNodeHash } from '../src/hash.js';
import type { ActionNode, PNode, PracticeNode } from '../src/model.js';

const FAKE = `sha256:${'a'.repeat(64)}`;
const FAKE2 = `sha256:${'b'.repeat(64)}`;
const GHOST = `sha256:${'d'.repeat(64)}`;

function action(name: string, extra: Partial<ActionNode> = {}): ActionNode {
  return { type: 'action', name, content: '', ...extra };
}

function practice(name: string, op: PracticeNode['op'], children: string[], extra: Partial<PracticeNode> = {}): PracticeNode {
  return {
    type: 'practice', name, content: '', op,
    children: children.map(h => ({ hash: h })),
    ...extra,
  };
}

/** Index a node under its computed hash — how every workspace and test fixture addresses nodes */
function put(nodes: Map<string, PNode>, n: PNode): string {
  const h = computeNodeHash(n);
  nodes.set(h, n);
  return h;
}

function fixture(): Map<string, PNode> {
  const nodes = new Map<string, PNode>();
  const boilH = put(nodes, action('Boil water', { attachments: [{ name: 'photo', hash: FAKE }] }));
  const rinseH = put(nodes, action('Rinse cup'));
  const gaiwanH = put(nodes, action('Gaiwan brew'));
  const glassH = put(nodes, action('Glass brew'));
  const prepH = put(nodes, practice('Prep', 'par', [boilH, rinseH]));
  const pickH = put(nodes, practice('Pick', 'choice', [gaiwanH, glassH]));
  const repeatH = put(nodes, practice('Repeat rinse', 'loop', [rinseH], { loop: { mode: 'count', count: 3 } }));
  put(nodes, practice('Make tea', 'seq', [prepH, pickH, repeatH]));
  return nodes;
}

describe('aggregateView', () => {
  it('declared inputs/outputs ride the aggregate view with provenance (needs and productions are visible to readers and search)', () => {
    const nodes = new Map<string, PNode>();
    const boilH = put(nodes, action('Boil water', { outputs: [{ name: 'boiling water', spec: '100°C' }] }));
    const pourH = put(nodes, action('Pour', {
      inputs: [{ name: 'boiling water', from: boilH }],
      outputs: [{ name: 'cup of tea', spec: '85°C' }],
    }));
    const p = put(nodes, practice('Make tea', 'seq', [boilH, pourH]));
    const v = aggregateView(p, nodes);
    expect(v.outputs).toEqual([
      { name: 'boiling water', spec: '100°C', refHash: boilH },
      { name: 'cup of tea', spec: '85°C', refHash: pourH },
    ]);
    expect(v.inputs).toEqual([{ name: 'boiling water', refHash: pourH }]);
  });

  it('unwired inputs (no from) still appear as declared needs, even though they generate no flow edge', () => {
    const nodes = new Map<string, PNode>();
    const prepH = put(nodes, action('Prep', { inputs: [{ name: 'PBS buffer', spec: 'pH 7.4' }] }));
    const p = put(nodes, practice('Stain', 'seq', [prepH]));
    const v = aggregateView(p, nodes);
    expect(v.flow).toEqual([]);
    expect(v.inputs).toEqual([{ name: 'PBS buffer', spec: 'pH 7.4', refHash: prepH }]);
  });

  it('set op: directory view aggregates no declared flows either', () => {
    const nodes = new Map<string, PNode>();
    const aH = put(nodes, action('A', { outputs: [{ name: 'thing' }] }));
    const bH = put(nodes, action('B', { inputs: [{ name: 'thing' }] }));
    const collectionH = put(nodes, practice('Collection', 'set', [aH, bH]));
    const v = aggregateView(collectionH, nodes);
    expect(v.inputs).toEqual([]);
    expect(v.outputs).toEqual([]);
  });

  it('action view: single step + own attachments', () => {
    const nodes = fixture();
    const boil = [...nodes.values()].find(n => n.name === 'Boil water')!;
    const boilH = computeNodeHash(boil);
    const v = aggregateView(boilH, nodes);
    expect(v.steps).toHaveLength(1);
    expect(v.steps[0]).toMatchObject({ name: 'Boil water', refHash: boilH });
    expect(v.attachments).toEqual([{ name: 'photo', hash: FAKE, refHash: boilH }]);
  });

  it('seq/par/choice/loop annotations land on the first step of the subtree', () => {
    const nodes = fixture();
    const tea = [...nodes.values()].find(n => n.name === 'Make tea')!;
    const v = aggregateView(computeNodeHash(tea), nodes);
    expect(v.steps.map(s => s.name)).toEqual(['Boil water', 'Rinse cup', 'Gaiwan brew', 'Glass brew', 'Rinse cup']);
    expect(v.steps.find(s => s.name === 'Boil water')!.note).toContain('parallel');
    expect(v.steps.find(s => s.name === 'Gaiwan brew')!.note).toContain('choose one');
    const rinseNotes = v.steps.filter(s => s.name === 'Rinse cup').map(s => s.note ?? '');
    expect(rinseNotes.some(n => n.includes('parallel'))).toBe(true);
    expect(rinseNotes.some(n => n.includes('repeat 3 times'))).toBe(true);
  });

  it('attachments deduplicated by hash+name (same blob under a different name = different use, kept)', () => {
    const nodes = new Map<string, PNode>();
    const a1 = put(nodes, action('A-one', { attachments: [{ name: 'photo', hash: FAKE }] }));
    const a2 = put(nodes, action('A-two', { attachments: [{ name: 'photo', hash: FAKE }] })); // same blob+name → deduped
    const a3 = put(nodes, action('A-three', { attachments: [{ name: 'screenshot', hash: FAKE }] })); // same blob, different name → kept
    const a4 = put(nodes, action('A-four', { attachments: [{ name: 'photo', hash: FAKE2 }] })); // different blob → kept
    const p = put(nodes, practice('P', 'seq', [a1, a2, a3, a4]));
    const v = aggregateView(p, nodes);
    expect(v.attachments).toEqual([
      { name: 'photo', hash: FAKE, refHash: a1 },
      { name: 'screenshot', hash: FAKE, refHash: a3 },
      { name: 'photo', hash: FAKE2, refHash: a4 },
    ]);
  });

  it('flow: inputs.from edges are derived bottom-up, keyed by hash', () => {
    const nodes = fixture();
    const tap = `sha256:${'c'.repeat(64)}`;
    const boil = [...nodes.values()].find(n => n.name === 'Boil water') as ActionNode;
    boil.inputs = [{ name: 'cold water', from: tap }];
    const tea = [...nodes.values()].find(n => n.name === 'Make tea')!;
    const v = aggregateView(computeNodeHash(tea), nodes);
    const edge = v.flow.find(f => f.name === 'cold water')!;
    expect(edge.fromHash).toBe(tap);
    expect(edge.toHash).toBe(computeNodeHash(boil));
  });

  it('until loop: renders the predicate instead of inventing a count', () => {
    const nodes = new Map<string, PNode>();
    const rinseH = put(nodes, action('Rinse cup'));
    const probe = put(nodes, practice('Probe', 'loop', [rinseH], { loop: { mode: 'until', until: 'the wash runs clear and foam-free' } }));
    const v = aggregateView(probe, nodes);
    expect(v.steps[0].note).toContain('repeat until: the wash runs clear and foam-free');
  });

  it('mixed-depth tree (par branch first): numbering monotonic, depths correct', () => {
    // make2: seq[ prep(par)[a1, a2], b ] — a1/a2 deeper than b
    const nodes = new Map<string, PNode>();
    const a1 = put(nodes, action('A-one'));
    const a2 = put(nodes, action('A-two'));
    const b = put(nodes, action('B'));
    const prep = put(nodes, practice('Prep', 'par', [a1, a2]));
    const make2 = put(nodes, practice('Mixed', 'seq', [prep, b]));
    const v = aggregateView(make2, nodes);
    const a1s = v.steps.find(s => s.name === 'A-one')!;
    const a2s = v.steps.find(s => s.name === 'A-two')!;
    const bs = v.steps.find(s => s.name === 'B')!;
    expect(a1s.depth - bs.depth).toBe(1); // A-one/A-two deeper than B
    expect(a2s.depth - bs.depth).toBe(1);
    expect(a1s.note).toBe('parallel');
    expect(a2s.note).toBe('parallel');
  });

  it('set op: directory view — children as entries, no execution aggregation', () => {
    const nodes = fixture();
    const tea = [...nodes.values()].find(n => n.name === 'Make tea')!;
    const teaH = computeNodeHash(tea);
    const boilH = computeNodeHash([...nodes.values()].find(n => n.name === 'Boil water')!);
    const deployH = put(nodes, practice('Deploy', 'seq', [boilH], { description: 'Deploy summary' }));
    const collectionH = put(nodes, practice('Collection', 'set', [teaH, deployH]));
    const v = aggregateView(collectionH, nodes);
    expect(v.steps).toEqual([
      { refHash: teaH, name: 'Make tea', depth: 0 },
      { refHash: deployH, name: 'Deploy', depth: 0, description: 'Deploy summary' },
    ]);
    expect(v.flow).toEqual([]);
    expect(v.attachments).toEqual([]); // no subtree attachment aggregation
  });

  it('twins: the same child hash on two paths renders as two steps (sharing is legal)', () => {
    const nodes = new Map<string, PNode>();
    const rinse = put(nodes, action('Rinse cup'));
    const p = put(nodes, practice('Double', 'seq', [rinse, rinse]));
    const v = aggregateView(p, nodes);
    expect(v.steps.map(s => s.refHash)).toEqual([rinse, rinse]);
  });

  it('dangling reference raises E_DANGLING', () => {
    const nodes = new Map<string, PNode>();
    const bad = put(nodes, practice('Bad', 'seq', [GHOST]));
    expect(() => aggregateView(bad, nodes)).toThrowError(/nonexistent/);
  });

  it('nonexistent node raises E_NOT_FOUND', () => {
    expect(() => aggregateView(GHOST, new Map())).toThrowError(/does not exist/);
  });
});
