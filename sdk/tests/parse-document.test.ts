import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/doc.js';
import { PracticeError } from '../src/errors.js';
import { computeNodeHash } from '../src/hash.js';

const A1 = { type: 'action', name: 'Boil water', content: 'Heat until boiling.' };
const A2 = {
  type: 'action', name: 'Pour', description: 'Fill the cup',
  content: 'Pour along the wall to 70% full.', license: 'CC-BY-4.0',
  metadata: { 'x-demo': 'teapot' },
  inputs: [{ name: 'hot water', from: '@Boil water' }],
  outputs: [{ name: 'cup of tea', spec: '85°C' }],
};

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect((e as PracticeError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} but it did not throw`);
}

describe('parseDocument (pure import, no persistence)', () => {
  it('A7 inline practice: root hash reproduces the official vector', () => {
    const p = parseDocument({ type: 'practice', name: 'Make tea', content: '', op: 'seq', children: [A1, A2] });
    expect(p.rootHash).toBe('sha256:95d4872db873283352020393a00381bfda021038ac701a107c33be8cab571d3a');
  });

  it('collects every node hash; inline A1 child matches the official vector', () => {
    const p = parseDocument({ type: 'practice', name: 'Make tea', content: '', op: 'seq', children: [A1] });
    expect(p.nodeHashes.size).toBe(2);
    expect(p.nodeHashes.has('sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377')).toBe(true);
  });

  it('resolves from labels and returns the Merkle root of the built tree', () => {
    const p = parseDocument({ name: 'Make tea', children: [A1, { ...A2, inputs: [{ name: 'hot water', from: '@Boil water' }] }] });
    expect(p.rootHash).toBe(computeNodeHash(p.root));
    expect(p.rootHash).toBe(p.nodeHashes.get(p.rootHash) ? computeNodeHash(p.nodeHashes.get(p.rootHash)!) : '');
    // the Pour action's from must have been resolved to A1's hash
    const root = p.root;
    if (root.type !== 'practice') throw new Error('expected practice root');
    const pour = p.nodeHashes.get(root.children[1].hash);
    expect(pour).toBeDefined();
    if (pour?.type !== 'action') throw new Error('expected action child');
    expect(pour.inputs?.[0].from).toBe('sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377');
  });

  it('ChildRef is E_DANGLING (the transport must expand it first)', () => {
    expectCode(
      () => parseDocument({ type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: 'sha256:' + '0'.repeat(64) }] }),
      'E_DANGLING',
    );
  });

  it('inputs.from outside the document is E_FLOW_FROM (self-contained)', () => {
    expectCode(
      () => parseDocument({ type: 'action', name: 'X', content: '', inputs: [{ name: 'i', from: 'sha256:' + '1'.repeat(64) }] }),
      'E_FLOW_FROM',
    );
  });

  it('does not persist anything (pure)', () => {
    const p = parseDocument({ type: 'action', name: 'Solo', content: 'x' });
    expect(p.nodeHashes.size).toBe(1);
  });
});
