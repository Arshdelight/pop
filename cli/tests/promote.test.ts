import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

/** `practi note add` reports `noted on <short> — id <8hex>` */
function noteId(stdout: string): string {
  const m = stdout.match(/id ([0-9a-f]{8})/);
  if (!m) throw new Error(`expected a note id in:\n${stdout}`);
  return m[1];
}

// note promote：把本地笔记回流成**草稿文档**（只产草稿，绝不自动 edit）
describe('note promote', () => {
  it('drafts the owning direct root and inserts the note at the pinned node', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, {
      name: 'Root practice',
      content: 'root prose',
      children: [
        { name: 'First step', content: 'first body' },
        { name: 'Second step', content: 'second body' },
      ],
    })])).stdout);
    // 钉到**间接**的第二步上——插入点必须是那一步，不是根
    const view = JSON.parse((await pop(dir, ['show', root, '--json'])).stdout);
    const second = (view.steps as { name: string; refHash: string }[]).find((s) => s.name === 'Second step')!.refHash;
    const id = noteId((await pop(dir, ['note', 'add', second, '-m', '实测：第二步要先关掉浏览器'])).stdout);

    const draft = await pop(dir, ['note', 'promote', id]);
    expect(draft.code).toBe(0);
    const doc = JSON.parse(draft.stdout);
    expect(doc.name).toBe('Root practice');
    expect(doc.children[1].content).toContain('实测：第二步要先关掉浏览器'); // 原文逐字保留
    expect(doc.children[1].content).toContain(`promote ${id}`);
    expect(doc.children[0].content).not.toContain('promote');
    expect(doc.content).not.toContain('promote');
    // 人看的信息走 stderr，JSON 独占 stdout（可重定向）
    expect(draft.stderr).toContain('next:');
  });

  it('the draft is accepted by `practi new` and keeps the note text', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Solo practice', content: 'body text' })])).stdout);
    const id = noteId((await pop(dir, ['note', 'add', root, '-m', '复现时发现的坑：先关浏览器'])).stdout);

    const draft = await pop(dir, ['note', 'promote', id]);
    expect(draft.code).toBe(0);
    const file = path.join(dir, 'draft.json');
    fs.writeFileSync(file, draft.stdout, 'utf8');

    const created = await pop(dir, ['new', file]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('status:   valid, registered as direct');

    const newRoot = createdRoot(created.stdout);
    const doc = JSON.parse((await pop(dir, ['show', newRoot, '--doc'])).stdout);
    expect(doc.content).toContain('复现时发现的坑：先关浏览器');
  });

  it('--out writes the draft to a file and reports the path', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Out file practice', content: 'body' })])).stdout);
    const id = noteId((await pop(dir, ['note', 'add', root, '-m', 'note body'])).stdout);
    const out = path.join(dir, 'draft-out.json');

    const r = await pop(dir, ['note', 'promote', id, '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('written:');
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(doc.name).toBe('Out file practice');
    expect(doc.content).toContain('note body');
  });

  it('refuses a note whose pinned version is gone (E_NOTE_DANGLING), and bad ids', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Doomed practice', content: 'body' })])).stdout);
    const id = noteId((await pop(dir, ['note', 'add', root, '-m', 'learning'])).stdout);
    // 把根从目录里拿掉 → 旧版本不可达被 GC，笔记随之悬空
    expect((await pop(dir, ['remove', root])).code).toBe(0);

    const dangling = await pop(dir, ['note', 'promote', id]);
    expect(dangling.code).toBe(1);
    expect(dangling.stderr).toContain('E_NOTE_DANGLING');

    const ghost = await pop(dir, ['note', 'promote', 'ffffffff']);
    expect(ghost.code).toBe(1);
    expect(ghost.stderr).toContain('not found');

    const noArg = await pop(dir, ['note', 'promote']);
    expect(noArg.code).toBe(1);
  });
});
