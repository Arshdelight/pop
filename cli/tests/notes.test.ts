import fs from 'node:fs';
import path from 'node:path';
import { type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainOf, freePort, init, runIn, spawnWeb, tempDataDir, untilHealthy, writeDoc } from './helpers.js';

/**
 * practi note：本地学习笔记（sidecar .practi/notes.json，钉在节点哈希上）。
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

function notesFile(repo: string): string {
  return path.join(repo, '.practi', 'notes.json');
}

function readNotes(repo: string): { schema: number; notes: NoteEntry[] } {
  return JSON.parse(fs.readFileSync(notesFile(repo), 'utf8'));
}

function writeNotes(repo: string, file: { schema: number; notes: NoteEntry[] }): void {
  fs.writeFileSync(notesFile(repo), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 按名字找节点哈希：池节点文件名=去前缀内容哈希，frontmatter 有 `name: X` 行 */
function hashByName(repo: string, name: string): string {
  const nodes = path.join(repo, '.practi', 'nodes');
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

/** 实例文件夹：首版=doc */
async function setup(doc: Record<string, unknown>, name = 'my-practice'): Promise<{ home: string; repo: string; root: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  await runIn(parent, home, ['new', name, '--base', writeDoc(parent, 'seed.json', doc)]);
  const repo = path.join(parent, name);
  return { home, repo, root: chainOf(repo).commits[0]!.root };
}

describe('practi note add/list', () => {
  it('add pins a note to the resolved hash in full sha256: form; list --json reads it back', async () => {
    const { home, repo, root } = await setup(ACTION);

    const r = await runIn(repo, home, ['note', 'add', root, '-m', '第一遍复现：烧开要三分钟，不是三十秒']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^noted on [0-9a-f]{12} — id [0-9a-f]{8}$/m);

    const file = readNotes(repo);
    expect(file.schema).toBe(1);
    expect(file.notes).toHaveLength(1);
    expect(file.notes[0].hash).toBe(root);
    expect(file.notes[0].content).toBe('第一遍复现：烧开要三分钟，不是三十秒');
    expect(file.notes[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(file.notes[0].updatedAt).toBe(file.notes[0].createdAt);

    const list = await runIn(repo, home, ['note', 'list', '--json']);
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.stdout) as NoteEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(file.notes[0].id);
  });

  it('accepts the bare 64-hex form and normalizes it to the prefixed form', async () => {
    const { home, repo, root } = await setup(ACTION);

    const r = await runIn(repo, home, ['note', 'add', root.slice('sha256:'.length), '-m', 'bare hex works']);
    expect(r.code).toBe(0);
    expect(readNotes(repo).notes[0].hash).toBe(root);
  });

  it('list <hash> filters to that node subtree; sibling and root notes are excluded', async () => {
    const { home, repo, root } = await setup(TREE);
    const boil = hashByName(repo, 'Boil');
    const pour = hashByName(repo, 'Pour');

    expect((await runIn(repo, home, ['note', 'add', pour, '-m', 'pour note'])).code).toBe(0);
    expect((await runIn(repo, home, ['note', 'add', boil, '-m', 'boil note'])).code).toBe(0);
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'root note'])).code).toBe(0);

    const onlyPour = JSON.parse((await runIn(repo, home, ['note', 'list', pour, '--json'])).stdout) as NoteEntry[];
    expect(onlyPour).toHaveLength(1);
    expect(onlyPour[0].content).toBe('pour note');

    const wholeTree = JSON.parse((await runIn(repo, home, ['note', 'list', root, '--json'])).stdout) as NoteEntry[];
    expect(wholeTree).toHaveLength(3);

    // 人读视图：按文档分组，组题=文档名，笔记行带节点名
    const human = await runIn(repo, home, ['note', 'list', root]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Make tea');
    expect(human.stdout).toContain('Pour');
    expect(human.stdout).toContain('pour note');
  });

  it('rejects unknown node hashes and missing -m content', async () => {
    const { home, repo, root } = await setup(ACTION);

    const unknown = await runIn(repo, home, ['note', 'add', 'deadbeef', '-m', 'x']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/does not exist/i);

    const noMessage = await runIn(repo, home, ['note', 'add', root]);
    expect(noMessage.code).toBe(1);
    expect(noMessage.stderr).toMatch(/usage/i);
  });
});

describe('practi note edit/delete', () => {
  it('edit updates content + updatedAt (id prefix OK); delete removes; repeats fail', async () => {
    const { home, repo, root } = await setup(ACTION);
    const id = noteId((await runIn(repo, home, ['note', 'add', root, '-m', 'v1'])).stdout);

    const edited = await runIn(repo, home, ['note', 'edit', id.slice(0, 4), '-m', 'v2 — 修正：是三分钟']);
    expect(edited.code).toBe(0);
    const after = readNotes(repo).notes[0];
    expect(after.id).toBe(id);
    expect(after.content).toBe('v2 — 修正：是三分钟');
    expect(after.updatedAt >= after.createdAt).toBe(true);

    const removed = await runIn(repo, home, ['note', 'delete', id.slice(0, 6)]);
    expect(removed.code).toBe(0);
    expect(readNotes(repo).notes).toHaveLength(0);

    const again = await runIn(repo, home, ['note', 'delete', id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/not found/);
  });

  it('ambiguous id prefixes are refused, not guessed', async () => {
    const { home, repo, root } = await setup(ACTION);
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'a'])).code).toBe(0);
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'b'])).code).toBe(0);

    // 随机 id 不保证共前缀：手工改成可辨歧义的形状（sidecar 就是给人修的）
    const file = readNotes(repo);
    file.notes[0].id = 'aaaa1111';
    file.notes[1].id = 'aaaa2222';
    writeNotes(repo, file);

    const r = await runIn(repo, home, ['note', 'edit', 'aaaa', '-m', 'x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/matches 2 notes/);
  });
});

describe('GET/POST /api/notes: notes data window', () => {
  const home = tempDataDir();
  const parent = tempDataDir();
  const repo = path.join(parent, 'my-practice');
  let child: ChildProcess;
  let base: string;
  let root: string;
  let pour: string;

  beforeAll(async () => {
    await init(home);
    await runIn(parent, home, ['new', 'my-practice', '--base', writeDoc(parent, 'seed.json', TREE)]);
    root = chainOf(repo).commits[0]!.root;
    pour = hashByName(repo, 'Pour');
    expect((await runIn(repo, home, ['note', 'add', pour, '-m', 'pour note'])).code).toBe(0);
    expect((await runIn(repo, home, ['note', 'add', root, '-m', 'root note'])).code).toBe(0);
    const port = await freePort();
    child = spawnWeb(repo, home, port);
    base = await untilHealthy(port, child);
  });

  afterAll(() => {
    child?.kill();
  });

  it('serves notes grouped by hash; ?ref=<hash> filters to that exact node', async () => {
    const whole = (await (await fetch(`${base}/api/notes`)).json()) as Record<string, NoteEntry[]>;
    expect(Object.keys(whole).sort()).toEqual([root, pour].sort());
    expect(whole[pour]).toHaveLength(1);
    expect(whole[pour][0].content).toBe('pour note');

    const sub = (await (await fetch(`${base}/api/notes?ref=${encodeURIComponent(pour)}`)).json()) as Record<string, NoteEntry[]>;
    expect(Object.keys(sub)).toEqual([pour]);
    expect(sub[pour][0].hash).toBe(pour);
    // 精确哈希过滤（不做子树解析）：未知的 ref 只是空结果，不是 404
    expect((await fetch(`${base}/api/notes?ref=deadbeef`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/notes?ref=deadbeef`)).json()).toEqual({});
  });

  it('POST is same-origin gated (no Origin / cross-origin → 400)', async () => {
    const post = async (body: unknown, origin?: string) => {
      const r = await fetch(`${base}/api/notes`, {
        method: 'POST',
        headers: origin === undefined ? {} : { origin },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as { error?: string } | null };
    };

    expect((await post({ op: 'noop' })).status).toBe(400);
    const evil = await post({ op: 'noop' }, 'http://evil.example');
    expect(evil.status).toBe(400);
    expect(evil.json?.error).toContain('same-origin POST required');
  });

  it('POST add/update/delete roundtrip through the second write door', async () => {
    const post = async (body: unknown) => {
      const r = await fetch(`${base}/api/notes`, {
        method: 'POST',
        headers: { origin: base },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null };
    };
    const notesAt = async (hash: string) => {
      const view = (await (await fetch(`${base}/api/notes?ref=${encodeURIComponent(hash)}`)).json()) as Record<string, NoteEntry[]>;
      return view[hash] ?? [];
    };

    // add：走完整 hash；GET 立即可见
    const added = await post({ op: 'add', hash: pour, text: 'web-added' });
    expect(added.status).toBe(200);
    expect(added.json?.ok).toBe(true);
    const afterAdd = await notesAt(pour);
    expect(afterAdd).toHaveLength(2);
    const id = afterAdd.find((n) => n.content === 'web-added')!.id;
    expect(id).toMatch(/^[0-9a-f]{8}$/);

    // update + delete；坏 op/缺字段 400
    const updated = await post({ op: 'update', id, text: 'web-edited' });
    expect(updated.status).toBe(200);
    expect((await notesAt(pour)).find((n) => n.id === id)?.content).toBe('web-edited');
    expect((await post({ op: 'delete', id })).status).toBe(200);
    expect(await notesAt(pour)).toHaveLength(1);
    expect((await post({ op: 'noop' })).status).toBe(400);
    expect((await post({ op: 'add', hash: pour })).status).toBe(400); // 缺 text
    expect((await post({ op: 'add', text: 'no hash' })).status).toBe(400); // 缺 hash
  });
});
