import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, readState, tempDataDir, writeDoc } from './helpers.js';

function nodeFile(dir: string, hash: string): string {
  return path.join(dir, 'nodes', `${hash.slice('sha256:'.length)}.md`);
}

function directOf(stdout: string): string[] {
  return JSON.parse(stdout).direct.map((v: { hash: string }) => v.hash);
}

function allNodes(lsJson: string): { hash: string; name: string }[] {
  const v = JSON.parse(lsJson);
  return [...v.direct, ...v.indirect];
}

// practi remove — 注册层操作：把 direct 根从本地目录拿掉（direct≈git refs，增删不产生新 commit）。
// --remote 委托 lifecycle 的远端认领撤除（delete 是它的别名）。
describe('practi remove: local directory removal', () => {
  it('takes the root out of direct, GCs its exclusive nodes, prunes the claim stamp', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot(
      (await pop(dir, ['new', writeDoc(dir, { name: 'Practice A', children: [{ name: 'Solo step', content: 'only in A' }] })])).stdout
    );
    expect(readState(dir).claims?.[root]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const r = await pop(dir, ['remove', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('removed:');
    expect(r.stdout).toContain('gc:       removed 2 unreachable node(s)'); // 根+独有子节点

    const ls = await pop(dir, ['ls', '--json']);
    expect(directOf(ls.stdout)).toEqual([]);
    expect(fs.existsSync(nodeFile(dir, root))).toBe(false);
    expect(readState(dir).claims?.[root]).toBeUndefined(); // 认领时刻随 direct 退出被修剪
  });

  it('--keep is gone (remove removes — unknown option is rejected)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Keep me' })])).stdout);

    const r = await pop(dir, ['remove', root, '--keep']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('keep'); // parseArgs 的 unknown option 报错
    expect(directOf((await pop(dir, ['ls', '--json'])).stdout)).toEqual([root]); // 什么都没动
  });

  it('a shared indirect node survives removing one of its referencing roots', async () => {
    const dir = tempDataDir();
    await init(dir);
    // A 内联独享 X；B 用 {hash} 引用同一个 X → X 被两棵树共享
    const a = createdRoot(
      (await pop(dir, ['new', writeDoc(dir, { name: 'Doc A', children: [{ name: 'Shared X', content: 'shared body' }] })])).stdout
    );
    const listing = await pop(dir, ['ls', '-a', '--json']);
    const x = allNodes(listing.stdout).find(n => n.name === 'Shared X');
    expect(x).toBeTruthy();
    const b = createdRoot(
      (await pop(dir, ['new', writeDoc(dir, { name: 'Doc B', children: [{ hash: x.hash }] })])).stdout
    );

    const r = await pop(dir, ['remove', a]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gc:       removed 1 unreachable node(s)'); // 只清 A 根；X 被 B 引用保得住
    expect(fs.existsSync(nodeFile(dir, x.hash))).toBe(true);
    expect(fs.existsSync(nodeFile(dir, a))).toBe(false);
    expect(directOf((await pop(dir, ['ls', '--json'])).stdout)).toEqual([b]);
  });

  it('refuses a hash that is not a direct root (indirect nodes leave with their root)', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Host', children: [{ name: 'Inner', content: 'indirect' }] })]);
    const listing = await pop(dir, ['ls', '-a', '--json']);
    const inner = allNodes(listing.stdout).find(n => n.name === 'Inner');
    expect(inner).toBeTruthy();
    const r = await pop(dir, ['remove', inner.hash]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not one of your direct pops');
  });

  it('argless remove is a usage error (stderr + exit 1); --remote flavors the hint', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['remove']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: practi remove');

    const rr = await pop(dir, ['remove', '--remote']);
    expect(rr.code).toBe(1);
    expect(rr.stderr).toContain('explicit hash required');
  });
});

describe('practi remove --remote: delegates to the hub claim withdrawal (delete stays an alias)', () => {
  it('offline: fails fast (not logged in) and leaves the local registration intact', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Local stays' })])).stdout);

    const r = await pop(dir, ['remove', root, '--remote']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not logged in');
    expect(directOf((await pop(dir, ['ls', '--json'])).stdout)).toEqual([root]);
  });

  it('practi delete is retired (unknown command) — remove --remote is the only face', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Alias check' })])).stdout);

    const r = await pop(dir, ['delete', root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command: delete');
    expect(directOf((await pop(dir, ['ls', '--json'])).stdout)).toEqual([root]); // 本地不动
  });
});
