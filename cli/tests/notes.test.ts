import fs from 'node:fs';
import path from 'node:path';
import { type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createdRoot, freePort, init, pop, spawnWeb, tempDataDir, untilHealthy } from './helpers.js';

/**
 * practi note：本地学习笔记（sidecar notes.json，钉在节点哈希上）。
 * 全部走真 CLI 子进程（argv 解析/退出码/stdout），notes.json 用普通 fs 断言；
 * /api/notes 数据窗 spawn 真 web server 打真 HTTP。
 */

const ACTION = { name: 'Boil water', content: 'Heat the drinking water to boiling.' };
const TREE = {
  name: 'Make tea',
  description: 'From kettle to cup',
  children: [
    { name: 'Boil', content: 'Heat water to a rolling boil.' },
    { name: 'Pour', content: 'Pour along the wall to 70% full.' },
  ],
};

interface NoteEntry {
  id: string;
  hash: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

function readNotes(dir: string): { schema: number; notes: NoteEntry[] } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
}

function writeNotes(dir: string, file: { schema: number; notes: NoteEntry[] }): void {
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 按名字找节点哈希：节点文件名=去前缀内容哈希，frontmatter 有 `name: X` 行 */
function hashByName(dir: string, name: string): string {
  const nodes = path.join(dir, 'nodes');
  for (const f of fs.readdirSync(nodes)) {
    const txt = fs.readFileSync(path.join(nodes, f), 'utf8');
    if (txt.split('\n').some(l => l.trim() === `name: ${name}`)) return `sha256:${f.replace(/\.md$/, '')}`;
  }
  throw new Error(`node named "${name}" not found in ${nodes}`);
}

function noteId(stdout: string): string {
  const m = stdout.match(/^noted on [0-9a-f]{12} — id ([0-9a-f]{8})$/m);
  if (!m) throw new Error(`expected a "noted on … — id …" line:\n${stdout}`);
  return m[1];
}

describe('practi note add/list', () => {
  it('add pins a note to the resolved hash in full sha256: form; list --json reads it back', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);

    const r = await pop(dir, ['note', 'add', root, '-m', '第一遍复现：烧开要三分钟，不是三十秒']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^noted on [0-9a-f]{12} — id [0-9a-f]{8}$/m);

    const file = readNotes(dir);
    expect(file.schema).toBe(1);
    expect(file.notes).toHaveLength(1);
    expect(file.notes[0].hash).toBe(root);
    expect(file.notes[0].content).toBe('第一遍复现：烧开要三分钟，不是三十秒');
    expect(file.notes[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(file.notes[0].updatedAt).toBe(file.notes[0].createdAt);

    const list = await pop(dir, ['note', 'list', '--json']);
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.stdout) as NoteEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(file.notes[0].id);
  });

  it('accepts the bare 64-hex form and normalizes it to the prefixed form', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);

    const r = await pop(dir, ['note', 'add', root.slice('sha256:'.length), '-m', 'bare hex works']);
    expect(r.code).toBe(0);
    expect(readNotes(dir).notes[0].hash).toBe(root);
  });

  it('list <hash> filters to that node subtree; sibling and root notes are excluded', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(TREE)])).stdout);
    const boil = hashByName(dir, 'Boil');
    const pour = hashByName(dir, 'Pour');

    expect((await pop(dir, ['note', 'add', pour, '-m', 'pour note'])).code).toBe(0);
    expect((await pop(dir, ['note', 'add', boil, '-m', 'boil note'])).code).toBe(0);
    expect((await pop(dir, ['note', 'add', root, '-m', 'root note'])).code).toBe(0);

    const onlyPour = JSON.parse((await pop(dir, ['note', 'list', pour, '--json'])).stdout) as NoteEntry[];
    expect(onlyPour).toHaveLength(1);
    expect(onlyPour[0].content).toBe('pour note');

    const wholeTree = JSON.parse((await pop(dir, ['note', 'list', root, '--json'])).stdout) as NoteEntry[];
    expect(wholeTree).toHaveLength(3);

    // 人读视图：按文档分组，组题=文档名，笔记行带节点名
    const human = await pop(dir, ['note', 'list', root]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Make tea');
    expect(human.stdout).toContain('Pour');
    expect(human.stdout).toContain('pour note');
  });

  it('rejects unknown node hashes and missing -m content', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);

    const unknown = await pop(dir, ['note', 'add', 'deadbeef', '-m', 'x']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/does not exist/i);

    const noMessage = await pop(dir, ['note', 'add', root]);
    expect(noMessage.code).toBe(1);
    expect(noMessage.stderr).toMatch(/usage/i);
  });
});

describe('practi note edit/delete', () => {
  it('edit updates content + updatedAt (id prefix OK); delete removes; repeats fail', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);
    const id = noteId((await pop(dir, ['note', 'add', root, '-m', 'v1'])).stdout);

    const edited = await pop(dir, ['note', 'edit', id.slice(0, 4), '-m', 'v2 — 修正：是三分钟']);
    expect(edited.code).toBe(0);
    const after = readNotes(dir).notes[0];
    expect(after.id).toBe(id);
    expect(after.content).toBe('v2 — 修正：是三分钟');
    expect(after.updatedAt >= after.createdAt).toBe(true);

    const removed = await pop(dir, ['note', 'delete', id.slice(0, 6)]);
    expect(removed.code).toBe(0);
    expect(readNotes(dir).notes).toHaveLength(0);

    const again = await pop(dir, ['note', 'delete', id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/not found/);
  });

  it('ambiguous id prefixes are refused, not guessed', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);
    await pop(dir, ['note', 'add', root, '-m', 'a']);
    await pop(dir, ['note', 'add', root, '-m', 'b']);

    // 随机 id 不保证共前缀：手工改成可辨歧义的形状（sidecar 就是给人修的）
    const file = readNotes(dir);
    file.notes[0].id = 'aaaa1111';
    file.notes[1].id = 'aaaa2222';
    writeNotes(dir, file);

    const r = await pop(dir, ['note', 'edit', 'aaaa', '-m', 'x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/matches 2 notes/);
  });
});

describe('GET /api/notes: notes data window', () => {
  const dir = tempDataDir();
  let child: ChildProcess;
  let base: string;
  let root: string;
  let pour: string;

  beforeAll(async () => {
    await init(dir);
    root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(TREE)])).stdout);
    pour = hashByName(dir, 'Pour');
    expect((await pop(dir, ['note', 'add', pour, '-m', 'pour note'])).code).toBe(0);
    expect((await pop(dir, ['note', 'add', root, '-m', 'root note'])).code).toBe(0);
    const port = await freePort();
    child = spawnWeb(dir, port);
    base = await untilHealthy(port, child);
  });

  afterAll(() => {
    child?.kill();
  });

  it('serves subtree-filtered notes for a ref', async () => {
    const whole = await (await fetch(`${base}/api/notes?ref=${encodeURIComponent(root)}`)).json();
    expect(whole.notes).toHaveLength(2);

    const sub = await (await fetch(`${base}/api/notes?ref=${encodeURIComponent(pour)}`)).json();
    expect(sub.notes).toHaveLength(1);
    expect(sub.notes[0].hash).toBe(pour);
    expect(sub.notes[0].content).toBe('pour note');
  });

  it('missing ref is a 400, unresolvable ref a 404', async () => {
    expect((await fetch(`${base}/api/notes`)).status).toBe(400);
    expect((await fetch(`${base}/api/notes?ref=deadbeef`)).status).toBe(404);
  });
});
