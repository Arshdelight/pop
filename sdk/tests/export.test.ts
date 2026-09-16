import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFromDoc } from '../src/doc.js';
import { runCreate, runInit, tempDir } from './helpers.js';

import { exportSubtree } from '../src/export.js';
import { computeNodeHash } from '../src/hash.js';
import { loadWorkspace, saveNode, storeBlob } from '../src/store.js';
import type { ActionNode, PracticeNode } from '../src/model.js';

/**
 * Document-shape round-trip (protocol layer): exportSubtree (tree → document)
 * and createFromDoc (document → tree) are inverses. Any subtree exported →
 * imported into a fresh workspace → hash byte-identical is the direct
 * verification that "the document shape is isomorphic to the protocol".
 */

const T = { interactive: true, json: true } as const;

async function setup(): Promise<string> {
  const dir = tempDir();
  await runInit(dir, { json: true });
  return dir;
}

function writeDoc(dir: string, doc: unknown): string {
  const file = path.join(dir, 'doc.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return 'doc.json';
}

describe('exportSubtree ↔ createFromDoc round-trip', () => {
  it('revisions/refines/attachments survive with all fields, hash byte-identical', async () => {
    const dir = await setup();
    const blobHash = storeBlob(dir, Buffer.from('photo-bytes'));
    const tree = {
      name: 'A tree with history',
      revisions: [{ when: '2026-08-19', what: 'initial version', trigger: 'external trigger' }],
      refines: `sha256:${'e'.repeat(64)}`, // history pointer, outside the workspace (dangling tolerated)
      children: [
        {
          name: 'leaf',
          content: 'x',
          attachments: [{ name: 'photo.png', hash: blobHash, mime: 'image/png', size: 'photo-bytes'.length }],
          outputs: [{ name: 'hot water' }],
          revisions: [{ when: '2026-08-18', what: 'leaf revision', from: `sha256:${'d'.repeat(64)}` }],
        },
      ],
    };
    const created = await runCreate(dir, { file: writeDoc(dir, tree), ...T });

    // Export → import into a fresh workspace
    const ws1 = loadWorkspace(dir);
    const doc = exportSubtree(ws1.nodes.get(created.root)!, ws1.nodes);
    const target = tempDir();
    const ws2 = { root: target, config: { name: 't', schema: 1 }, nodes: new Map(), parseIssues: [], texts: new Map() };
    const result = createFromDoc(ws2, doc);

    // Idempotent re-export (the same document through the round-trip again, identity unchanged)
    const ws2loaded = loadWorkspace(target);
    expect(result.count).toBe(2);
    const root = ws2loaded.nodes.get(result.root)!;
    expect(computeNodeHash(root)).toBe(created.root); // hash identical
    expect(root.type === 'practice' && root.refines).toBe(tree.refines); // refines preserved
    expect(root.revisions).toEqual(tree.revisions); // root revisions preserved
    const leaf = [...ws2loaded.nodes.values()].find(n => n.name === 'leaf')!;
    expect(leaf.type === 'action' && leaf.attachments).toEqual(tree.children[0].attachments); // attachment pointers preserved
    expect(leaf.revisions).toEqual(tree.children[0].revisions); // leaf revisions preserved

    // Blobs are content-addressed storage: store the same content in the target
    // workspace and the pointer reconciles
    storeBlob(target, Buffer.from('photo-bytes'));
    const doc2 = exportSubtree(root, ws2loaded.nodes);
    expect(JSON.stringify(doc2)).toBe(JSON.stringify(doc)); // re-export byte-identical to the original
  });

  it('DAG sharing is legal: the same child under two parents exports and imports fine', async () => {
    const dir = await setup();
    const shared = await runCreate(dir, { file: writeDoc(dir, { name: 'Shared leaf', content: 'x' }), ...T });
    const sub = await runCreate(dir, {
      file: writeDoc(dir, { name: 'Sub practice', children: [{ hash: shared.root }] }),
      ...T,
    });
    const dag = await runCreate(dir, {
      file: writeDoc(dir, { name: 'DAG root', children: [{ hash: shared.root }, { hash: sub.root }] }),
      ...T,
    });

    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(dag.root)!, ws.nodes);
    // The shared leaf is inlined twice (twins) — a legal document shape
    expect(doc.children).toHaveLength(2);
    const target = tempDir();
    const round = createFromDoc(
      { root: target, config: { name: 't', schema: 1 }, nodes: new Map(), parseIssues: [], texts: new Map() },
      doc,
    );
    expect(round.root).toBe(dag.root); // identical identity through the round-trip
  });

  it('dangling pin exports verbatim as { hash } (read tolerance; re-import hits E_DANGLING)', () => {
    const dir = tempDir();
    const ghost = `sha256:${'7'.repeat(64)}`;
    const p: PracticeNode = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: ghost }] };
    const hash = saveNode(dir, p); // hashing never checks pin existence — validation does
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(hash)!, ws.nodes);
    expect(doc.children).toEqual([{ hash: ghost }]);
  });

  it('action export: a leaf is a legal single-node document', () => {
    const dir = tempDir();
    const a: ActionNode = { type: 'action', name: 'Leaf', content: 'x' };
    const hash = saveNode(dir, a);
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(hash)!, ws.nodes);
    expect(doc).toEqual({ type: 'action', name: 'Leaf', content: 'x' });
  });
});

describe('from pins exported as @name sugar (round-trip follows edits)', () => {
  async function twoStep(dir: string, producerContent: string): Promise<string> {
    const created = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'P',
        children: [
          { name: 'Producer', content: producerContent, outputs: [{ name: 'artifact', spec: 'ok' }] },
          { name: 'Consumer', content: 'use', inputs: [{ name: 'artifact', from: '@Producer' }] },
        ],
      }),
      ...T,
    });
    return created.root;
  }

  it('in-subtree from exports as @name; unedited round-trip keeps the root hash identical', async () => {
    const dir = await setup();
    const root = await twoStep(dir, 'v1');
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(root)!, ws.nodes) as { children: { inputs: { from: string }[] }[] };
    expect(doc.children[1].inputs[0].from).toBe('@Producer'); // the label, not the stale-prone hash pin
    const target = tempDir();
    const round = createFromDoc(
      { root: target, config: { name: 't', schema: 1 }, nodes: new Map(), parseIssues: [], texts: new Map() },
      doc,
    );
    expect(round.root).toBe(root); // the label resolves back to the same hash
  });

  it('editing the producer no longer strands from: the label re-resolves to the new hash', async () => {
    const dir = await setup();
    const root = await twoStep(dir, 'v1');
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(root)!, ws.nodes) as Record<string, unknown> & {
      children: { name: string; content: string }[];
    };
    doc.children[0].content = 'v2'; // the producer's edit changes its hash — the old pin would dangle
    const round = createFromDoc(ws, doc); // same workspace: the old producer node still exists
    expect(round.root).not.toBe(root);
    const ws2 = loadWorkspace(dir);
    const producerV2 = [...ws2.nodes.values()].find(n => n.name === 'Producer' && n.content === 'v2')!;
    const consumerFollows = [...ws2.nodes.values()].find(
      n => n.type === 'action' && n.name === 'Consumer' && n.inputs?.[0]?.from === computeNodeHash(producerV2),
    );
    expect(consumerFollows).toBeDefined(); // from followed the edit instead of pinning the dead hash
  });

  it('out-of-subtree from keeps the verbatim hash pin', async () => {
    const dir = await setup();
    const ext = await runCreate(dir, {
      file: writeDoc(dir, { name: 'External source', content: 'x', outputs: [{ name: 'thing' }] }),
      ...T,
    });
    const created = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'P',
        children: [{ name: 'Consumer', content: 'y', inputs: [{ name: 'thing', from: ext.root }] }],
      }),
      ...T,
    });
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(created.root)!, ws.nodes) as { children: { inputs: { from: string }[] }[] };
    expect(doc.children[0].inputs[0].from).toBe(ext.root); // no label available outside the subtree
  });

  it('an ambiguous name (same name, distinct content) keeps the hash pin', async () => {
    const dir = await setup();
    const first = await runCreate(dir, {
      file: writeDoc(dir, { name: 'Step', content: 'a', outputs: [{ name: 'thing' }] }),
      ...T,
    });
    const created = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'P',
        children: [
          { hash: first.root },
          { name: 'Step', content: 'b' },
          { name: 'Consumer', content: 'c', inputs: [{ name: 'thing', from: first.root }] },
        ],
      }),
      ...T,
    });
    const ws = loadWorkspace(dir);
    const doc = exportSubtree(ws.nodes.get(created.root)!, ws.nodes) as { children: { inputs: { from: string }[] }[] };
    expect(doc.children[2].inputs[0].from).toBe(first.root); // NOT '@Step' — two distinct Steps live in this subtree
  });
});
