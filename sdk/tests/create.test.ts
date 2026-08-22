import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeNodeHash } from '../src/hash.js';
import { loadWorkspace } from '../src/store.js';
import { runAddAction, runCreate, runInit, runShow, runValidate, tempDir } from './helpers.js';

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

describe('create: build a practice tree in one shot', () => {
  it('until loop: mode=until builds a tree with a natural-language predicate', async () => {
    const dir = await setup();
    const doc = {
      name: 'Immunostaining wash',
      children: [
        {
          name: 'PBS wash',
          op: 'loop',
          loop: { mode: 'until', until: 'the wash runs clear' },
          children: [{ name: 'Soak', content: 'Immerse the slices in PBS, gently shake for 5 minutes.' }],
        },
      ],
    };
    const r = await runCreate(dir, { file: writeDoc(dir, doc), ...T });
    expect(r.count).toBe(3);
    const view = await runShow(dir, { hash: r.root });
    expect(view.steps[0].note).toContain('repeat until: the wash runs clear');
    const check = await runValidate(dir, { json: true });
    expect(check.ok).toBe(true);
  });

  it('until loop without a predicate is an E_LOOP error (JSON path included)', async () => {
    const dir = await setup();
    const doc = { name: 'Bad loop', children: [{ name: 'Child', op: 'loop', loop: { mode: 'until' }, children: [{ name: 'Leaf' }] }] };
    await expect(runCreate(dir, { file: writeDoc(dir, doc), ...T })).rejects.toMatchObject({
      code: 'E_LOOP',
      message: expect.stringContaining('until'),
    });
  });

  it('an op outside the legal set → E_OP', async () => {
    const dir = await setup();
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', op: 'sometimes', children: [{ name: 'y', content: '' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_OP' });
  });

  it('nested tree: mix of ChildRef and inline children, flow wired by hash', async () => {
    const dir = await setup();
    const boil = await runAddAction(dir, { name: 'Boil water', content: 'Heat the drinking water to boiling.', ...T });
    const doc = {
      name: 'Make green tea',
      description: 'From kettle to cup',
      children: [
        { hash: boil.root }, // ChildRef: reuse the stored action
        { name: 'Steep', op: 'loop', loop: { mode: 'count', count: 2 }, children: [{ name: 'Smell', content: 'Open the lid and smell.' }] },
        { name: 'Pour', content: 'Pour along the wall to 70% full.', inputs: [{ name: 'hot water', from: boil.root }] },
      ],
    };
    const r = await runCreate(dir, { file: writeDoc(dir, doc), ...T });
    expect(r.count).toBe(4); // steep + smell + pour + parent (boil reused, not re-created)

    const view = await runShow(dir, { hash: r.root });
    expect(view.steps.map(s => s.name)).toEqual(['Boil water', 'Smell', 'Pour']);
    expect(view.steps[1].note).toContain('repeat 2 times');
    expect(view.flow).toEqual([
      { name: 'hot water', fromHash: boil.root, fromName: 'Boil water', toHash: view.steps[2].refHash, toName: 'Pour' },
    ]);
    const check = await runValidate(dir, { json: true });
    expect(check.ok).toBe(true);
  });

  it('name is required (the only label a node carries); unknown fields are rejected, not dropped (§8)', async () => {
    const dir = await setup();
    await expect(runCreate(dir, { file: writeDoc(dir, { content: 'no name' }), ...T })).rejects.toMatchObject({ code: 'E_SCHEMA' });
    await expect(runCreate(dir, { file: writeDoc(dir, { name: 'x', foo: 1, children: [{ name: 'y', content: '' }] }), ...T }))
      .rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('foo') });
    await expect(runCreate(dir, { file: writeDoc(dir, { name: 'child', content: 'x', hash: 'sha256:zzz' }), ...T }))
      .rejects.toMatchObject({ code: 'E_SCHEMA' }); // a stray hash key on a node is an unknown field — rejected loudly (§8)
  });

  it('bare-string children are not a legal form (nodes are addressed by hash only)', async () => {
    const dir = await setup();
    await expect(runCreate(dir, { file: writeDoc(dir, { name: 'x', children: ['anything'] }), ...T }))
      .rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('bare strings') });
  });

  it('structural invariants rejected at import: derived-view field on a practice / empty children / loop on non-loop op', async () => {
    const dir = await setup();
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', inputs: [], children: [{ name: 'y', content: '' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, { name: 'x', op: 'seq', loop: { mode: 'count', count: 2 }, children: [{ name: 'y', content: '' }] }),
      }),
    ).rejects.toMatchObject({ code: 'E_LOOP' });
  });

  it('unresolved from → E_FLOW_FROM; pointing at an existing workspace node hash is legal', async () => {
    const dir = await setup();
    const ghost = `sha256:${'0'.repeat(64)}`;
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'x',
          children: [{ name: 'y', content: '', inputs: [{ name: 'item', from: ghost }] }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'E_FLOW_FROM' });

    const shared = await runAddAction(dir, { name: 'Shared action', content: 'prep', ...T });
    const r = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'z',
        children: [
          { name: 'w', content: '', inputs: [{ name: 'shared output', from: shared.root }] },
        ],
      }),
      ...T,
    });
    expect(r.count).toBe(2);
    const view = await runShow(dir, { hash: r.root });
    expect(view.flow[0].fromHash).toBe(shared.root);
  });

  it('action root: a document without children yields a single action', async () => {
    const dir = await setup();
    const r = await runCreate(dir, { file: writeDoc(dir, { name: 'Single action', content: 'Just a leaf.' }), ...T });
    expect(r.count).toBe(1);
    const view = await runShow(dir, { hash: r.root });
    expect(view.type).toBe('action');
  });

  it('license/metadata: round-trip through create → show; non-string metadata value → E_SCHEMA', async () => {
    const dir = await setup();
    const r = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'Licensed skill',
        license: 'MIT',
        metadata: { 'x-hub-rating': '4' },
        children: [{ name: 'Step', content: 'do it' }],
      }),
      ...T,
    });
    expect(r.count).toBe(2);
    const view = await runShow(dir, { hash: r.root });
    expect(view.license).toBe('MIT');
    expect(view.metadata).toEqual({ 'x-hub-rating': '4' });
    // metadata values are arbitrary JSON — a skill's list-valued frontmatter maps without flattening
    const rich = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'Rich meta',
        metadata: { 'x-tools': ['Bash', 'Read'], 'x-version': 2, 'x-flags': { verbose: true } },
      }),
      ...T,
    });
    expect(rich.count).toBe(1);
    const richView = await runShow(dir, { hash: rich.root });
    expect(richView.metadata).toEqual({ 'x-tools': ['Bash', 'Read'], 'x-version': 2, 'x-flags': { verbose: true } });
  });

  it('inline media references: dangling name → E_MEDIA_REF; http(s) URL target is a valid external reference', async () => {
    const dir = await setup();
    const h = `sha256:${'a'.repeat(64)}`;
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'x',
          children: [{ name: 'y', content: 'See ![fig](a.png)', attachments: [{ name: 'b.png', hash: h }] }],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_MEDIA_REF' });
    // http(s) URL targets are valid external references (§5.1) — no attachment-table entry required, best-effort
    const okUrl = await runCreate(dir, {
      file: writeDoc(dir, { name: 'x2', children: [{ name: 'y2', content: '![external](https://e.com/x.png)' }] }),
      ...T,
    });
    expect(okUrl.count).toBe(2);
    // scheme matching is case-insensitive (RFC 3986)
    const okUpper = await runCreate(dir, {
      file: writeDoc(dir, { name: 'x3', children: [{ name: 'y3', content: '![external](HTTPS://e.com/x.png)' }] }),
      ...T,
    });
    expect(okUpper.count).toBe(2);
    // Matching pair → tree builds (blob existence is validate's job; import checks name resolution only)
    const ok = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'z',
        children: [{ name: 'w', content: 'See ![fig](a.png)', attachments: [{ name: 'a.png', hash: h }] }],
      }),
      ...T,
    });
    expect(ok.count).toBe(2);
    // Duplicate attachment names are rejected at import
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'dup-att',
          children: [{
            name: 'w2',
            content: '',
            attachments: [{ name: 'a.png', hash: h }, { name: 'a.png', hash: `sha256:${'b'.repeat(64)}` }],
          }],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
  });

  it('attachments: optional url (http/https) is parsed; non-http(s) url → E_SCHEMA', async () => {
    const dir = await setup();
    const h = `sha256:${'a'.repeat(64)}`;
    const ok = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'u',
        children: [{ name: 'v', content: 'See ![fig](a.png)', attachments: [{ name: 'a.png', hash: h, url: 'https://cdn.example.com/a.png' }] }],
      }),
      ...T,
    });
    expect(ok.count).toBe(2);
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'bad',
          children: [{ name: 'w', content: '', attachments: [{ name: 'a.png', hash: h, url: 'not-a-url' }] }],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
    // urls are preserved verbatim (§5.1): edge whitespace is rejected, never trimmed away
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'spaced',
          children: [{ name: 'w', content: '', attachments: [{ name: 'a.png', hash: h, url: ' https://e.com/a.png ' }] }],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
  });

  it('ChildRef children ({ hash }): reference already-stored nodes, never re-create them', async () => {
    const dir = await setup();
    const boil = await runAddAction(dir, { name: 'Boil water', content: 'Heat until boiling.', ...T });
    const pour = await runAddAction(dir, { name: 'Pour', content: 'Pour along the wall.', ...T });

    const r = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'Make tea',
        children: [
          { hash: boil.root },
          { hash: pour.root },
        ],
      }),
      ...T,
    });
    // Only the parent practice is new; the children are reused under their own hashes
    expect(r.count).toBe(1);
    expect(r.created).toEqual([r.root]);

    const ws = loadWorkspace(dir);
    const root = ws.nodes.get(r.root)!;
    expect(root.type).toBe('practice');
    expect(root.type === 'practice' && root.children).toEqual([
      { hash: boil.root },
      { hash: pour.root },
    ]);
    const check = await runValidate(dir, { json: true });
    expect(check.ok).toBe(true);
  });

  it('ChildRef children: dangling / malformed hash (any type) / extra fields are rejected loudly', async () => {
    const dir = await setup();
    const boil = await runAddAction(dir, { name: 'Boil water', content: 'Heat until boiling.', ...T });

    // 引用未存储的 hash → E_DANGLING
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [{ hash: `sha256:${'0'.repeat(64)}` }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_DANGLING' });

    // hash 格式错误 → E_HASH_FORMAT
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'y', children: [{ hash: 'not-a-hash' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_HASH_FORMAT' });

    // hash 类型错误（数字）→ 同样大声报 E_HASH_FORMAT，绝不静默当成内联节点
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'y2', children: [{ hash: 666 }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_HASH_FORMAT' });

    // 带多余字段 → E_SCHEMA
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'w', children: [{ hash: boil.root, name: 'Boil water' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA' });
  });

  it('§8 strictness: unknown fields and wrong-typed values are rejected loudly, never dropped', async () => {
    const dir = await setup();
    // a flow item carrying an unknown field (document channel) → E_SCHEMA
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [{ name: 'y', outputs: [{ name: 'o', foo: 1 }] }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('foo') });
    // a loop config carrying an unknown key → E_SCHEMA
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, { name: 'x', children: [{ name: 'c', op: 'loop', loop: { mode: 'count', count: 2, foo: 1 }, children: [{ name: 'l' }] }] }),
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('foo') });
    // count on an until-loop is not a silent "cap" — it is rejected
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, { name: 'x', children: [{ name: 'c', op: 'loop', loop: { mode: 'until', until: 'clear', count: 9 }, children: [{ name: 'l' }] }] }),
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('count') });
    // wrong-typed scalars → E_SCHEMA (never a silent drop: the author wrote them, the hash must not lose them)
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', description: 42, children: [{ name: 'y', content: '' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('description') });
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [{ name: 'y', content: '', inputs: [{ name: 'i', from: 666 }] }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('from') });
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', content: 5 }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('content') });
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', type: 7, children: [{ name: 'y', content: '' }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('type') });
  });

  it('from authoring sugar: "@name" labels resolve to hashes at import (need vs wiring)', async () => {
    const dir = await setup();
    const r = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'Make tea',
        children: [
          { name: 'Boil water', content: 'Heat until boiling.', outputs: [{ name: 'boiling water', spec: '100°C' }] },
          { name: 'Pour', content: 'Pour along the wall.', inputs: [{ name: 'boiling water', from: '@Boil water' }] },
        ],
      }),
      ...T,
    });
    expect(r.count).toBe(3);
    const ws = loadWorkspace(dir);
    const boil = [...ws.nodes.values()].find(n => n.name === 'Boil water')!;
    const boilHash = computeNodeHash(boil);
    const pour = [...ws.nodes.values()].find(n => n.name === 'Pour')!;
    // the stored form carries the hash — the label never survives import
    expect(pour.type === 'action' && pour.inputs?.[0].from).toBe(boilHash);
    const view = await runShow(dir, { hash: r.root });
    expect(view.flow).toEqual([
      { name: 'boiling water', fromHash: boilHash, fromName: 'Boil water', toHash: computeNodeHash(pour), toName: 'Pour' },
    ]);
    const check = await runValidate(dir, { json: true });
    expect(check.ok).toBe(true);
  });

  it('from-labels: unknown → E_SCHEMA; ambiguous (same name, different content) → E_SCHEMA; twins resolve fine', async () => {
    const dir = await setup();
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [{ name: 'y', content: '', inputs: [{ name: 'i', from: '@Ghost' }] }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('@Ghost') });
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'amb',
          children: [
            { name: 'Rinse', content: 'a' },
            { name: 'Rinse', content: 'b' },
            { name: 'Use', content: '', inputs: [{ name: 'item', from: '@Rinse' }] },
          ],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('ambiguous') });
    // twins: same name AND same content → same hash → the label resolves, no ambiguity
    const ok = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'tw',
        children: [
          { name: 'Rinse', content: 'same' },
          { name: 'Rinse', content: 'same' },
          { name: 'Use', content: '', inputs: [{ name: 'item', from: '@Rinse' }] },
        ],
      }),
      ...T,
    });
    expect(ok.count).toBe(4);
  });

  it('from-labels: a label pointing at an ancestor (self-containing dataflow) → E_SCHEMA cycle', async () => {
    const dir = await setup();
    await expect(
      runCreate(dir, {
        file: writeDoc(dir, {
          name: 'Outer',
          children: [
            { name: 'Inner', content: '', inputs: [{ name: 'x', from: '@Outer' }] },
          ],
        }),
        ...T,
      }),
    ).rejects.toMatchObject({ code: 'E_SCHEMA', message: expect.stringContaining('cycle') });
  });

  it('from values that are neither a hash nor a label → E_HASH_FORMAT', async () => {
    const dir = await setup();
    await expect(
      runCreate(dir, { file: writeDoc(dir, { name: 'x', children: [{ name: 'y', content: '', inputs: [{ name: 'i', from: 'boil' }] }] }), ...T }),
    ).rejects.toMatchObject({ code: 'E_HASH_FORMAT' });
  });

  it('twins: the same child hash may appear twice (content sharing is legal; no ids to collide)', async () => {
    const dir = await setup();
    const rinse = await runAddAction(dir, { name: 'Rinse', content: 'Rinse the cup.', ...T });
    const r = await runCreate(dir, {
      file: writeDoc(dir, {
        name: 'Double rinse',
        children: [{ hash: rinse.root }, { hash: rinse.root }],
      }),
      ...T,
    });
    expect(r.count).toBe(1);
    const ws = loadWorkspace(dir);
    const root = ws.nodes.get(r.root)!;
    expect(root.type === 'practice' && root.children).toEqual([{ hash: rinse.root }, { hash: rinse.root }]);
    const view = await runShow(dir, { hash: r.root });
    expect(view.steps).toHaveLength(2); // two occurrences, both steps rendered
  });
});
