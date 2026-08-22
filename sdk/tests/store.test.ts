import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspace, nodeFilePath, saveNode } from '../src/store.js';
import { computeNodeHash } from '../src/hash.js';
import type { ActionNode, PracticeNode } from '../src/model.js';
import { tempDir } from './helpers.js';

const FAKE = `sha256:${'a'.repeat(64)}`;

describe('store', () => {
  it('action write/read round-trip equivalence, keyed by content hash', () => {
    const dir = tempDir();
    const node: ActionNode = {
      type: 'action',
      name: 'Boil water',
      description: 'Heat to boiling',
      content: 'Bring the water to a boil.',
    };
    const hash = saveNode(dir, node);
    expect(hash).toBe(computeNodeHash(node));
    expect(path.basename(nodeFilePath(dir, hash))).toMatch(/^[0-9a-f]{64}\.md$/);
    const ws = loadWorkspace(dir);
    expect(ws.nodes.get(hash)).toEqual(node);
  });

  it('practice write/read round-trip equivalence (children pins/loop/refines)', () => {
    const dir = tempDir();
    const p: PracticeNode = {
      type: 'practice',
      name: 'P',
      content: '',
      op: 'loop',
      children: [{ hash: FAKE }],
      loop: { mode: 'count', count: 3 },
      refines: FAKE,
    };
    const hash = saveNode(dir, p);
    const ws = loadWorkspace(dir);
    expect(ws.nodes.get(hash)).toEqual(p);
  });

  it('unicode content + license/metadata + inputs/outputs write/read round-trip equivalence', () => {
    const dir = tempDir();
    const node: ActionNode = {
      type: 'action',
      name: '煮水',
      content: 'Boil.',
      license: 'CC-BY-4.0',
      metadata: { 'x-demo': 'teapot' },
      inputs: [{ name: 'cold water', spec: 'any' }],
      outputs: [{ name: 'hot water', spec: '85°C' }],
    };
    const hash = saveNode(dir, node);
    const ws = loadWorkspace(dir);
    expect(ws.nodes.get(hash)).toEqual(node);
  });

  it('identical content saved twice lands once (content-addressed file name)', () => {
    const dir = tempDir();
    const node: ActionNode = { type: 'action', name: 'X', content: 'same' };
    const h1 = saveNode(dir, node);
    const h2 = saveNode(dir, node);
    expect(h1).toBe(h2);
    expect(fs.readdirSync(path.join(dir, 'nodes'))).toHaveLength(1);
  });

  it('hand-edited node file → E_NODE_CORRUPT, not indexed (drift is impossible; this is tampering)', () => {
    const dir = tempDir();
    const node: ActionNode = { type: 'action', name: 'X', content: 'original' };
    const hash = saveNode(dir, node);
    const file = nodeFilePath(dir, hash);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('original', 'edited'), 'utf8');
    const ws = loadWorkspace(dir);
    expect(ws.nodes.size).toBe(0);
    expect(ws.parseIssues.some(i => i.code === 'E_NODE_CORRUPT' && i.message.includes(hash.slice(7, 19)))).toBe(true);
  });

  it('node file not named by a 64-hex hash → E_PARSE', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nodes', 'not-a-hash.md'), '---\ntype: action\nname: T\n---\ncontent\n', 'utf8');
    const ws = loadWorkspace(dir);
    expect(ws.nodes.size).toBe(0);
    expect(ws.parseIssues.some(i => i.code === 'E_PARSE')).toBe(true);
  });

  it('nested metadata values (lists/objects/numbers) survive the markdown round-trip', () => {
    const dir = tempDir();
    const node: ActionNode = {
      type: 'action',
      name: 'X',
      content: 'x',
      metadata: { 'x-tools': ['Bash', 'Read'], 'x-version': 2, 'x-flags': { verbose: true } },
    };
    const hash = saveNode(dir, node);
    const ws = loadWorkspace(dir);
    expect(ws.nodes.get(hash)).toEqual(node);
  });

  it('non-JSON YAML natives in metadata (unquoted dates, .nan) are rejected, never silently collapsed by hashing', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'d'.repeat(64)}.md`),
      '---\ntype: action\nname: T\nmetadata:\n  x-when: 2026-08-19\n---\ncontent\n',
      'utf-8',
    );
    let ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && /metadata|JSON/.test(i.message))).toBe(true);
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'d'.repeat(64)}.md`),
      '---\ntype: action\nname: T\nmetadata:\n  x-ratio: .nan\n---\ncontent\n',
      'utf-8',
    );
    ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && /non-finite|JSON/.test(i.message))).toBe(true);
    // quoted date-like strings are plain JSON strings and pass the metadata check
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'d'.repeat(64)}.md`),
      '---\ntype: action\nname: T\nmetadata:\n  x-when: "2026-08-19"\n---\ncontent\n',
      'utf-8',
    );
    ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && /metadata|JSON/.test(i.message))).toBe(false);
  });

  it('hand-written inputs on a practice → parse issue (derived-view rule)', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'a'.repeat(64)}.md`),
      `---\ntype: practice\nname: T\nop: seq\nchildren:\n  - hash: ${FAKE}\ninputs: []\n---\n`,
      'utf-8',
    );
    const ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && i.message.includes('inputs'))).toBe(true);
  });

  it('§8: an unrecognized frontmatter field is rejected, not dropped', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'b'.repeat(64)}.md`),
      '---\ntype: action\nname: T\nfoo: 1\n---\ncontent\n',
      'utf-8',
    );
    const ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && i.message.includes('foo'))).toBe(true);
  });

  it('§8: loop config unknown keys are rejected in the node-library channel too (mode-scoped key list)', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nodes', `${'c'.repeat(64)}.md`),
      `---\ntype: practice\nname: T\nop: loop\nloop:\n  mode: count\n  count: 2\n  foo: 1\nchildren:\n  - hash: ${FAKE}\n---\n`,
      'utf-8',
    );
    const ws = loadWorkspace(dir);
    expect(ws.parseIssues.some(i => i.code === 'E_SCHEMA' && i.message.includes('foo'))).toBe(true);
  });
});
