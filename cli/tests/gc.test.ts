import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, sha256, storedHash, tempDataDir, writeDoc } from './helpers.js';

function blobFile(dir: string, hash: string): string {
  const hex = hash.slice('sha256:'.length);
  return path.join(dir, 'blobs', hex.slice(0, 2), hex);
}

async function stage(dir: string, name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const r = await pop(dir, ['blob', 'add', file]);
  expect(r.code).toBe(0);
  return storedHash(r.stdout);
}

// practi gc — 清架工：孤儿=盘上存在、但盘上没有任何节点引用的附件字节。
// 引用判定取「盘上全部节点」：--keep 留下的旧节点挂着的附件不算孤儿。
describe('practi gc: sweep orphan blobs', () => {
  it('dry-run by default reports without deleting; --apply removes only orphans', async () => {
    const dir = tempDataDir();
    await init(dir);

    // 被引用的：进文档
    const keptBytes = Buffer.from('referenced png bytes');
    const kept = await stage(dir, 'fig.png', keptBytes);
    const doc = {
      name: 'Annotated step',
      content: 'See ![the figure](fig.png).',
      attachments: [{ name: 'fig.png', hash: kept, mime: 'image/png', size: keptBytes.length }],
    };
    expect((await pop(dir, ['new', writeDoc(dir, doc)])).code).toBe(0);

    // 孤儿：入库但从未被任何文档引用
    const stray = await stage(dir, 'stray.bin', Buffer.from('never referenced'));

    const dry = await pop(dir, ['gc']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('dry run, pass --apply to remove');
    expect(dry.stdout).toContain(sha256(Buffer.from('never referenced')).slice('sha256:'.length, 'sha256:'.length + 12));
    expect(fs.existsSync(blobFile(dir, kept))).toBe(true);
    expect(fs.existsSync(blobFile(dir, stray))).toBe(true);

    const apply = await pop(dir, ['gc', '--apply']);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain('1 orphan blob(s)');
    expect(apply.stdout).toContain('— removed');
    expect(fs.existsSync(blobFile(dir, stray))).toBe(false);
    expect(fs.readFileSync(blobFile(dir, kept)).toString()).toBe('referenced png bytes');

    const again = await pop(dir, ['gc']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('no orphan blobs');
  });

  it('a blob held only by an edit --keep leftover node survives gc', async () => {
    const dir = tempDataDir();
    await init(dir);

    const heldBytes = Buffer.from('kept via --keep node');
    const held = await stage(dir, 'old-fig.png', heldBytes);
    const v1 = {
      name: 'Annotated step',
      content: 'v1',
      attachments: [{ name: 'old-fig.png', hash: held, mime: 'image/png', size: heldBytes.length }],
    };
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, v1)])).stdout);

    // 换根到无附件版并 --keep：旧 action 节点不可达但仍躺在盘上，引用着 held
    const v2 = { name: 'Annotated step', content: 'v2 — attachment dropped' };
    const edit = await pop(dir, ['edit', root, writeDoc(dir, v2), '--keep']);
    expect(edit.code).toBe(0);

    const r = await pop(dir, ['gc', '--apply']);
    expect(r.code).toBe(0);
    // 旧节点在盘上 → held 不算孤儿，清不掉
    expect(fs.existsSync(blobFile(dir, held))).toBe(true);
    expect(r.stdout).toContain('no orphan blobs');
  });
});
