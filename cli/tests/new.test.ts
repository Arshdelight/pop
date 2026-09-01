import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, nodeFile, nodeFiles, pop, readState, tempDataDir, writeDoc } from './helpers.js';

const ACTION = { name: 'Boil water', content: 'Heat the drinking water to boiling.' };
const TREE = {
  name: 'Make tea',
  description: 'From kettle to cup',
  children: [
    ACTION,
    { name: 'Pour', content: 'Pour along the wall to 70% full.' },
  ],
};

describe('pop new: three input channels, one content-addressed result', () => {
  it('from a JSON file: stores the node under its hash and registers the root as direct', async () => {
    const dir = tempDataDir();
    await init(dir);

    const r = await pop(dir, ['new', writeDoc(dir, ACTION)]);
    expect(r.code).toBe(0);
    const root = createdRoot(r.stdout);
    expect(r.stdout).toMatch(/^nodes:\s+1$/m);
    expect(r.stdout).toContain('status:   valid, registered as direct');

    // the node file is named by the content hash; pop state carries the registration
    expect(fs.existsSync(nodeFile(dir, root))).toBe(true);
    expect(readState(dir).direct).toEqual([root]);
  });

  it('the same document via --json and via stdin yields the same root hash (content addressing)', async () => {
    const dir = tempDataDir();
    await init(dir);

    const fromFlag = await pop(dir, ['new', '--json', JSON.stringify(ACTION)]);
    expect(fromFlag.code).toBe(0);
    const fromStdin = await pop(dir, ['new'], { input: JSON.stringify(ACTION, null, 2) });
    expect(fromStdin.code).toBe(0);

    // identical content → identical identity, one node file, one registration
    const a = createdRoot(fromFlag.stdout);
    const b = createdRoot(fromStdin.stdout);
    expect(a).toBe(b);
    expect(nodeFiles(dir)).toHaveLength(1);
  });

  it('a tree document: child nodes land in nodes/ alongside the practice root', async () => {
    const dir = tempDataDir();
    await init(dir);

    const r = await pop(dir, ['new', writeDoc(dir, TREE)]);
    expect(r.code).toBe(0);
    const root = createdRoot(r.stdout);
    expect(r.stdout).toMatch(/^nodes:\s+3$/m); // boil + pour + parent

    const files = nodeFiles(dir);
    expect(files).toHaveLength(3);
    expect(files).toContain(`${root.slice('sha256:'.length)}.md`);
  });
});

describe('pop ls --json: the registry view', () => {
  it('lists the direct root as a StandardView; child nodes appear as indirect', async () => {
    const dir = tempDataDir();
    await init(dir);
    const created = await pop(dir, ['new', writeDoc(dir, TREE)]);
    const root = createdRoot(created.stdout);

    const r = await pop(dir, ['ls', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);

    expect(out.direct).toHaveLength(1);
    const view = out.direct[0];
    // the StandardView shape (aggregate.ts): derived steps/flow/attachments are part of the view
    expect(view).toMatchObject({
      hash: root,
      type: 'practice',
      name: 'Make tea',
      description: 'From kettle to cup',
    });
    expect(view.steps.map((s: { name: string }) => s.name)).toEqual(['Boil water', 'Pour']);
    expect(view.attachments).toEqual([]);
    expect(view.flow).toEqual([]);
    expect(view.inputs).toEqual([]);
    expect(view.outputs).toEqual([]);

    // only the ROOT is registered direct — the stored child nodes are indirect
    const byName = new Map(out.indirect.map((n: { name: string }) => [n.name, n]));
    expect([...byName.keys()].sort()).toEqual(['Boil water', 'Pour']);
    expect(byName.get('Boil water')).toMatchObject({ type: 'action', hash: view.steps[0].refHash });
  });

  it('determinism: running ls --json twice yields byte-identical stdout', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, TREE)]);

    const first = await pop(dir, ['ls', '--json']);
    const second = await pop(dir, ['ls', '--json']);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it('text mode lists the direct pops with their steps', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, TREE)]);

    const r = await pop(dir, ['ls']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Make tea');
    expect(r.stdout).toContain('Boil water');
    expect(r.stdout).toContain('Pour');
  });
});

describe('pop new: typed error surface', () => {
  it('an invalid document (unknown field) → nonzero exit, error [E_SCHEMA] on stderr naming the field', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', JSON.stringify({ name: 'x', foo: 1, children: [{ name: 'y', content: '' }] })]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error \[E_SCHEMA\]/);
    expect(r.stderr).toContain('foo');
    // nothing registered from a rejected document
    const ls = await pop(dir, ['ls', '--json']);
    expect(JSON.parse(ls.stdout).direct).toEqual([]);
  });

  it('malformed JSON → nonzero exit, error [E_JSON]', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', '{not json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error \[E_JSON\]/);
  });

  it('no input at all → usage on stderr, nonzero exit', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new'], { input: '' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: practi new');
  });
});

// --remote：只有远端——创作 JSON 直送 POST /api/v1/pop（hub 解析+算哈希+认领），本地零写入。
// 离线只钉得住失败分支：凭据检查先于网络。--publish 必须伴随 --remote，单独出现报错。
describe('pop new --remote: hub-only creation', () => {
  it('offline: fails at the credentials gate, nothing written locally', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', JSON.stringify({ name: 'Hub only', content: 'x' }), '--remote']);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('created:'); // 没到创建那一步
    expect(r.stderr).toContain('not logged in');
    // 本地零写入：无注册、无节点文件
    expect(readState(dir).direct).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'nodes')).length).toBe(0);
  });

  it('--publish without --remote is refused', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', JSON.stringify({ name: 'Bare publish', content: 'x' }), '--publish']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--publish requires --remote');
    expect(readState(dir).direct).toEqual([]); // 被拒于动手之前
  });

  it('--remote --publish offline: same credentials gate (POST precedes submit)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', JSON.stringify({ name: 'Chain', content: 'x' }), '--remote', '--publish']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
    expect(readState(dir).direct).toEqual([]);
  });

  it('without the flag the behavior is untouched (pure local create)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['new', '--json', JSON.stringify({ name: 'Plain new', content: 'x' })]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('status:   valid, registered as direct');
  });
});
