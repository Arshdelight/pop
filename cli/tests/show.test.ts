import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc } from './helpers.js';

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
