import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

const TREE = {
  name: 'Make tea',
  description: 'From kettle to cup',
  children: [
    { name: 'Boil water', content: 'Heat the drinking water to boiling.' },
    { name: 'Pour', content: 'Pour along the wall to 70% full.' },
  ],
};

describe('pop show: hash addressing (full hash and unique prefix)', () => {
  async function setup(): Promise<{ dir: string; root: string }> {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', writeDoc(dir, TREE)]);
    return { dir, root: createdRoot(r.stdout) };
  }

  it('by full hash: renders the aggregate view with the derived steps', async () => {
    const { dir, root } = await setup();
    const r = await pop(dir, ['show', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Make tea');
    expect(r.stdout).toContain('Boil water');
    expect(r.stdout).toContain('steps:');

    const json = await pop(dir, ['show', root, '--json']);
    expect(json.code).toBe(0);
    const view = JSON.parse(json.stdout);
    // the StandardView is the machine-readable form (hash identity + derived steps)
    expect(view.hash).toBe(root);
    expect(view.type).toBe('practice');
    expect(view.name).toBe('Make tea');
    expect(view.steps.map((s: { name: string }) => s.name)).toEqual(['Boil water', 'Pour']);
  });

  it('by unique short prefix: resolves to the same node (there are no local names)', async () => {
    const { dir, root } = await setup();
    const prefix = root.slice('sha256:'.length, 'sha256:'.length + 10);

    const byFull = await pop(dir, ['show', root]);
    const byPrefix = await pop(dir, ['show', prefix]);
    expect(byPrefix.code).toBe(0);
    // prefix resolution addresses the identical node → identical output
    expect(byPrefix.stdout).toBe(byFull.stdout);
  });

  it('--doc prints the document form (the authoring JSON round-trip channel)', async () => {
    const { dir, root } = await setup();
    const r = await pop(dir, ['show', root, '--doc']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.name).toBe('Make tea');
    expect(doc.children).toHaveLength(2);
    expect(doc.children[1]).toMatchObject({ name: 'Pour' });
  });

  it('an unknown hash → typed E_NOT_FOUND, nonzero exit', async () => {
    const { dir } = await setup();
    const r = await pop(dir, ['show', `sha256:${'0'.repeat(64)}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error \[E_NOT_FOUND\]/);
  });
});

// 哈希纪律（第 4 点）：本地「没找到」先区分「找到但哈希不正确」（加载层 E_NODE_CORRUPT），
// 完整哈希才回落 hub（前缀只对本地有意义）；远端内容重算后才展示。
describe('show: found-but-hash-mismatch is an error, never silent', () => {
  it('a hand-edited node file reports corruption, not plain not-found', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Victim', content: 'original' })])).stdout);
    const file = path.join(dir, 'nodes', `${root.slice('sha256:'.length)}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('original', 'tampered'));

    const r = await pop(dir, ['show', root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_NODE_CORRUPT');
    expect(r.stderr).toContain('the node file exists locally');
    expect(r.stderr).toContain('hashes to sha256:'); // 名实不符的实算值
  });

  it('a prefix that matches nothing says the hub fallback needs the full hash (no network)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['show', 'abcdef12']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_NOT_FOUND');
    expect(r.stderr).toContain('hub fallback needs the full hash');
  });

  it('a full hash missing locally fails fast against an unreachable hub (offline, no real network)', async () => {
    const dir = tempDataDir();
    await init(dir);
    // loadState 永远回落默认 remote（开箱即连），真离线只能指向死端口
    await pop(dir, ['remote', 'set', 'http://127.0.0.1:9']);
    const ghost = `sha256:${'c'.repeat(64)}`;
    const r = await pop(dir, ['show', ghost]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('hub unreachable');
  });

  it('local happy path unchanged: found node renders as before', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Plain', content: 'fine' })])).stdout);
    const r = await pop(dir, ['show', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Plain');
  });
});
