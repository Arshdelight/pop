import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, sha256, tempDataDir, writeDoc, workingFile } from './helpers.js';

const SEED = { name: 'Seed practice', description: 'holds the pool', content: 'A body long enough to stand as the first revision.' };

/** 带首版修订的实例文件夹 */
async function setup(): Promise<{ home: string; parent: string; repo: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  const file = writeDoc(parent, 'seed.json', SEED);
  await runIn(parent, home, ['new', 'my-practice', '--base', file]);
  return { home, parent, repo: path.join(parent, 'my-practice') };
}

function storedHash(stdout: string): string {
  const m = stdout.match(/^stored:  (sha256:[0-9a-f]{64})/m);
  if (!m) throw new Error(`expected a "stored:" line:\n${stdout}`);
  return m[1];
}

function blobFile(repo: string, hash: string): string {
  const hex = hash.slice('sha256:'.length);
  return path.join(repo, '.practi', 'blobs', hex.slice(0, 2), hex);
}

async function stage(home: string, parent: string, repo: string, name: string, bytes: Buffer): Promise<string> {
  const file = path.join(parent, name);
  fs.writeFileSync(file, bytes);
  const r = await runIn(repo, home, ['blob', 'add', file]);
  expect(r.code).toBe(0);
  return storedHash(r.stdout);
}

// practi gc — 清架工：孤儿=盘上存在、但盘上没有任何节点引用的附件字节。
// 引用判定取「池内全部节点」：历史修订留着的旧节点挂着的附件不算孤儿。
describe('practi gc: sweep orphan blobs', () => {
  it('dry-run by default reports without deleting; --apply removes only orphans', async () => {
    const { home, parent, repo } = await setup();

    // 被引用的：进头文档（blob add → 贴进工作文件 → commit）
    const keptBytes = Buffer.from('referenced png bytes');
    const kept = await stage(home, parent, repo, 'fig.png', keptBytes);
    const doc = {
      name: 'Annotated step',
      content: 'See ![the figure](fig.png).',
      attachments: [{ name: 'fig.png', hash: kept, mime: 'image/png', size: keptBytes.length }],
    };
    fs.writeFileSync(workingFile(repo), JSON.stringify(doc, null, 2) + '\n', 'utf8');
    const c = await runIn(repo, home, ['commit', '-m', 'attach']);
    expect(c.code, `stdout=${c.stdout} stderr=${c.stderr}`).toBe(0);

    // 孤儿：入库但从未被任何文档引用
    const stray = await stage(home, parent, repo, 'stray.bin', Buffer.from('never referenced'));

    const dry = await runIn(repo, home, ['gc']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('dry run, pass --apply to remove');
    expect(dry.stdout).toContain(sha256(Buffer.from('never referenced')).slice('sha256:'.length, 'sha256:'.length + 12));
    expect(fs.existsSync(blobFile(repo, kept))).toBe(true);
    expect(fs.existsSync(blobFile(repo, stray))).toBe(true);

    const apply = await runIn(repo, home, ['gc', '--apply']);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain('1 orphan blob(s)');
    expect(apply.stdout).toContain('— removed');
    expect(fs.existsSync(blobFile(repo, stray))).toBe(false);
    expect(fs.readFileSync(blobFile(repo, kept)).toString()).toBe('referenced png bytes');

    const again = await runIn(repo, home, ['gc']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('no orphan blobs');
  });

  it('a blob held only by an old revision node survives gc', async () => {
    const { home, parent, repo } = await setup();

    const heldBytes = Buffer.from('kept via an older revision');
    const held = await stage(home, parent, repo, 'old-fig.png', heldBytes);
    const v1 = {
      name: 'Annotated step',
      content: 'v1 with the attachment',
      attachments: [{ name: 'old-fig.png', hash: held, mime: 'image/png', size: heldBytes.length }],
    };
    fs.writeFileSync(workingFile(repo), JSON.stringify(v1, null, 2) + '\n', 'utf8');
    expect((await runIn(repo, home, ['commit', '-m', 'v1 with attachment'])).code).toBe(0);

    // v2 换到无附件版：v1 的 action 节点不可达但仍躺在池里，引用着 held
    const v2 = { name: 'Annotated step', description: 'attachment dropped', content: 'v2 — attachment dropped from the head document.' };
    fs.writeFileSync(workingFile(repo), JSON.stringify(v2, null, 2) + '\n', 'utf8');
    expect((await runIn(repo, home, ['commit', '-m', 'v2 drops the attachment'])).code).toBe(0);
    expect(chainOf(repo).commits).toHaveLength(3); // seed v0 + v1 + v2

    const r = await runIn(repo, home, ['gc', '--apply']);
    expect(r.code).toBe(0);
    // 池内的历史节点在 → held 不算孤儿，清不掉
    expect(fs.existsSync(blobFile(repo, held))).toBe(true);
    expect(r.stdout).toContain('no orphan blobs');
  });
});
