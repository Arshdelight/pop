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

  it('dangling pin → E_DANGLING at export', () => {
    const dir = tempDir();
    const ghost = `sha256:${'7'.repeat(64)}`;
    const p: PracticeNode = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: ghost }] };
    const hash = saveNode(dir, p); // hashing never checks pin existence — validation does
    const ws = loadWorkspace(dir);
    expect(() => exportSubtree(ws.nodes.get(hash)!, ws.nodes)).toThrowError(/E_DANGLING|nonexistent/);
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
