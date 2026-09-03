import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCreate, runInit, runStatus, runValidate, tempDir } from './helpers.js';
import { loadWorkspace, saveNode, storeBlob, blobPath, nodeFilePath } from '../src/store.js';
import { computeNodeHash } from '../src/hash.js';
import type { ActionNode, PNode, PracticeNode } from '../src/model.js';

/** spec §6 validation invariants: line-located errors, dangling references, node tampering, blob reconciliation, frontmatter schema rejection. */

const T = { interactive: true, json: true } as const;

const GHOST = `sha256:${'0'.repeat(64)}`;

async function setup(): Promise<string> {
  const dir = tempDir();
  await runInit(dir, { json: true });
  const doc = {
    name: 'Make tea',
    children: [{ name: 'Boil water', content: 'Heat the water to boiling.' }],
  };
  const file = path.join(dir, 'doc.json');
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  await runCreate(dir, { file: 'doc.json', ...T });
  return dir;
}

/** Re-persist a node with modifications — the only way to "edit": a changed node is a new hash; here we rebuild the same node object and save (tests keep the address by rebuilding from the loaded copy) */
function updateNode(dir: string, hash: string, edit: (n: PNode) => void): PNode {
  const ws = loadWorkspace(dir);
  const node = ws.nodes.get(hash)!;
  edit(node);
  saveNode(dir, node);
  return node;
}

describe('validate: structural invariants (spec §6)', () => {
  it('refinement graph (§7/§9.1): from pins and child pins whose target has a refinement are surfaced — advisory, never issues', async () => {
    const dir = await setup();
    const write = (doc: unknown): string => {
      fs.writeFileSync(path.join(dir, 'doc.json'), JSON.stringify(doc), 'utf8');
      return 'doc.json';
    };
    const boil = await runCreate(dir, { file: write({ name: 'Boil water', content: 'Heat until boiling.' }), ...T });
    // an improved version: a practice refining the stored boil action
    const better = await runCreate(dir, {
      file: write({ name: 'Boil water (kettle version)', refines: boil.root, children: [{ name: 'Fill kettle', content: 'Fill and switch on.' }] }),
      ...T,
    });
    // a consumer wiring from the original via a child pin AND a from pin
    const tea = await runCreate(dir, {
      file: write({
        name: 'Make tea',
        children: [
          { hash: boil.root },
          { name: 'Pour', content: 'Pour.', inputs: [{ name: 'boiling water', from: boil.root }] },
        ],
      }),
      ...T,
    });

    const status = await runStatus(dir, { json: true });
    const ws = loadWorkspace(dir);
    const pourHash = computeNodeHash([...ws.nodes.values()].find(n => n.name === 'Pour')!);
    expect(status.refinableInputs).toEqual([
      { node: pourHash, input: 'boiling water', from: boil.root, candidates: [better.root] },
    ]);
    expect(status.upgradeable).toEqual([
      { parent: tea.root, child: boil.root, candidates: [better.root] },
    ]);
    // advisory only: validate stays green
    const check = await runValidate(dir, { json: true });
    expect(check.ok).toBe(true);
  });

  it('parse issues carry line numbers: derived-view fields point at the offending frontmatter line', async () => {
    const dir = await setup();
    const ws = loadWorkspace(dir);
    const rootHash = computeNodeHash([...ws.nodes.values()].find(n => n.name === 'Make tea')!);
    const rootFile = nodeFilePath(dir, rootHash);
    fs.writeFileSync(rootFile, fs.readFileSync(rootFile, 'utf8').replace('op: seq', 'op: seq\ninputs:\n  - name: x'), 'utf8');
    // The edited file no longer hashes to its name → E_NODE_CORRUPT would fire; the parse error fires first (parse precedes hashing)
    const check = await runValidate(dir, { json: true });
    const schemaIssue = check.issues.find(i => i.code === 'E_SCHEMA')!;
    expect(schemaIssue.file).toContain(rootHash.slice(7, 19));
    expect(fs.readFileSync(path.join(dir, schemaIssue.file), 'utf8').split('\n')[schemaIssue.line! - 1].startsWith('inputs:')).toBe(true);
  });

  it('a hand-edited stored node → E_NODE_CORRUPT (editing changes identity; the old file name no longer matches)', async () => {
    const dir = await setup();
    const ws = loadWorkspace(dir);
    const boilHash = computeNodeHash([...ws.nodes.values()].find(n => n.name === 'Boil water')!);
    const file = nodeFilePath(dir, boilHash);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('boiling', 'BOILING'), 'utf8');
    const check = await runValidate(dir, { json: true });
    const corrupt = check.issues.find(i => i.code === 'E_NODE_CORRUPT')!;
    expect(corrupt.message).toContain(boilHash.slice(7, 19));
  });

  it('dangling child pin / dangling from → E_DANGLING / E_FLOW_FROM (a locally authored file may leave the state for later fixing; the document channel rejects at import)', async () => {
    const dir = await setup();
    const p: PracticeNode = { type: 'practice', name: 'Bad parent', content: '', op: 'seq', children: [{ hash: GHOST }] };
    saveNode(dir, p);
    const a: ActionNode = { type: 'action', name: 'Bad leaf', content: '', inputs: [{ name: 'item', from: GHOST }] };
    saveNode(dir, a);
    const check = await runValidate(dir, { json: true });
    expect(check.issues.some(i => i.code === 'E_DANGLING' && i.message.includes(GHOST))).toBe(true);
    expect(check.issues.some(i => i.code === 'E_FLOW_FROM' && i.message.includes(GHOST))).toBe(true);
  });

  it('blob reconciliation (spec §5): missing → E_BLOB_MISSING, tampering/size mismatch → E_BLOB_CORRUPT', async () => {
    const dir = await setup();
    const hash = storeBlob(dir, Buffer.from('original-bytes'));
    const ws = loadWorkspace(dir);
    const boilHash = computeNodeHash([...ws.nodes.values()].find(n => n.name === 'Boil water')!);

    // normal: no blob-related issues
    updateNode(dir, boilHash, n => {
      if (n.type === 'action') n.attachments = [{ name: 'a.bin', hash, size: 'original-bytes'.length }];
    });
    let check = await runValidate(dir, { json: true });
    expect(check.issues.filter(i => i.code.startsWith('E_BLOB'))).toEqual([]);

    // missing
    fs.rmSync(blobPath(dir, hash));
    check = await runValidate(dir, { json: true });
    let blobIssues = check.issues.filter(i => i.code.startsWith('E_BLOB'));
    expect(blobIssues).toHaveLength(1);
    expect(blobIssues[0].code).toBe('E_BLOB_MISSING');

    // tampered (content hash mismatch)
    fs.writeFileSync(blobPath(dir, hash), 'tampered');
    check = await runValidate(dir, { json: true });
    blobIssues = check.issues.filter(i => i.code.startsWith('E_BLOB'));
    expect(blobIssues).toHaveLength(1);
    expect(blobIssues[0].code).toBe('E_BLOB_CORRUPT');

    // size mismatch (hash correct)
    const other = storeBlob(dir, Buffer.from('another-blob'));
    updateNode(dir, boilHash, n => {
      if (n.type === 'action') n.attachments = [{ name: 'a.bin', hash: other, size: 999 }];
    });
    check = await runValidate(dir, { json: true });
    blobIssues = check.issues.filter(i => i.code.startsWith('E_BLOB'));
    expect(blobIssues.some(i => i.code === 'E_BLOB_CORRUPT' && i.message.includes('size'))).toBe(true);
  });

  it('inline media references (spec §5.1): matching pair passes, dangling → E_MEDIA_REF with line, duplicate names → E_SCHEMA, practice content unchecked', async () => {
    const dir = await setup();
    const hash = storeBlob(dir, Buffer.from('img-bytes'));
    const ws0 = loadWorkspace(dir);
    const boilHash = computeNodeHash([...ws0.nodes.values()].find(n => n.name === 'Boil water')!);

    const editBoil = (content: string, attachments: Array<{ name: string; hash: string }>): string => {
      return computeNodeHash(updateNode(dir, boilHash, n => {
        if (n.type === 'action') {
          n.content = content;
          n.attachments = attachments;
        }
      }) as PNode);
    };

    // reference matches the attachment list → no media issues
    editBoil('See the figure:\n![technique](shot.png)', [{ name: 'shot.png', hash }]);
    let check = await runValidate(dir, { json: true });
    expect(check.issues.filter(i => i.code === 'E_MEDIA_REF')).toEqual([]);

    // dangling: name not in the list → E_MEDIA_REF, line points at the reference
    editBoil('first line\n![missing](ghost.png)', [{ name: 'shot.png', hash }]);
    check = await runValidate(dir, { json: true });
    const ref = check.issues.find(i => i.code === 'E_MEDIA_REF')!;
    expect(ref.message).toContain('ghost.png');
    expect(fs.readFileSync(path.join(dir, ref.file), 'utf8').split('\n')[ref.line! - 1]).toContain('ghost.png');

    // v1.1.0: http(s) URL targets are not valid grammar — E_MEDIA_REF on the validate path too
    editBoil('See ![ext](https://cdn.example.com/hero.jpeg)', [{ name: 'shot.png', hash }]);
    check = await runValidate(dir, { json: true });
    expect(check.issues.some(i => i.code === 'E_MEDIA_REF' && i.message.includes('cdn.example.com'))).toBe(true);

    // duplicate attachment names → E_SCHEMA (content resolves by name; names must be unique per node)
    editBoil('![fig](shot.png)', [
      { name: 'shot.png', hash },
      { name: 'shot.png', hash: `sha256:${'9'.repeat(64)}` },
    ]);
    check = await runValidate(dir, { json: true });
    expect(check.issues.some(i => i.code === 'E_SCHEMA' && i.message.includes('duplicate'))).toBe(true);

    // image syntax inside practice content is not checked (no attachment table)
    const ws = loadWorkspace(dir);
    const teaHash = computeNodeHash([...ws.nodes.values()].find(n => n.name === 'Make tea')!);
    updateNode(dir, teaHash, n => {
      n.content = 'narrative with ![whatever](x.png) raises nothing';
    });
    check = await runValidate(dir, { json: true });
    expect(check.issues.some(i => i.code === 'E_MEDIA_REF' && i.message.includes('x.png'))).toBe(false);
  });
});
