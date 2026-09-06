import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createdRoot, init, nodeFile, pop, readState, tempDataDir } from './helpers.js';

const PARENT = {
  name: 'Make tea',
  children: [
    { name: 'Boil water', content: 'Heat the drinking water to boiling.' },
    { name: 'Pour', content: 'Pour along the wall.' },
  ],
};

// direct ⇄ indirect 认领转换：registry 层操作（direct ≈ git refs）。
// claim 把已存节点登记为 direct；unclaim 撤出注册——前提是仍被其它 direct 引用，
// 否则撤完即孤儿（下一次 GC 就没了），那属于 `practi remove` 的删除职责，必须报错。
describe('practi claim / unclaim', () => {
  it('claim registers an indirect node as direct; claiming again fails', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(PARENT)])).stdout);

    const ls = await pop(dir, ['ls', '--json']);
    const indirect = JSON.parse(ls.stdout).indirect as { hash: string; name: string }[];
    const child = indirect.find((n) => n.name === 'Boil water')!.hash;

    const out = await pop(dir, ['claim', child]);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/claimed:/);
    expect(readState(dir).direct).toContain(child);

    const again = await pop(dir, ['claim', child]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already registered/);
    expect(root).toBeTruthy();
  });

  it('unclaim returns a referenced direct pop to indirect (and back via claim)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(PARENT)])).stdout);
    const ls = JSON.parse((await pop(dir, ['ls', '--json'])).stdout);
    const child = ls.indirect.find((n: { name: string }) => n.name === 'Boil water').hash as string;
    await pop(dir, ['claim', child]);

    const un = await pop(dir, ['unclaim', child]);
    expect(un.code).toBe(0);
    expect(un.stdout).toMatch(/now indirect/);
    expect(un.stdout).toMatch(/referenced by: Make tea/);
    expect(readState(dir).direct).toEqual([root]);
    // 节点文件还在（indirect 存活），roundtrip 可逆
    expect(fs.existsSync(nodeFile(dir, child))).toBe(true);
    expect((await pop(dir, ['claim', child])).code).toBe(0);
  });

  it('unclaim of an unreferenced direct pop fails with E_NOT_REFERENCED (remove is the delete path)', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(PARENT)])).stdout);

    const un = await pop(dir, ['unclaim', root]);
    expect(un.code).toBe(1);
    expect(un.stderr).toMatch(/E_NOT_REFERENCED/);
    expect(un.stderr).toMatch(/practi remove/);
    expect(readState(dir).direct).toEqual([root]); // 注册表未动
  });
});

// 读取宽容（spec §2.3 写入严格）：子树引用的节点文件缺失 → 视图照常产出（占位条目），
// 尾部 E_MISSING 错误块 + 退出码 1；--doc 按 { hash } pin 原样导出
describe('missing referenced nodes (E_MISSING)', () => {
  it('show still renders the view but exits 1 with an E_MISSING block', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', '--json', JSON.stringify(PARENT)]);
    const ls = JSON.parse((await pop(dir, ['ls', '--json'])).stdout);
    const child = ls.indirect.find((n: { name: string }) => n.name === 'Boil water').hash as string;
    fs.unlinkSync(nodeFile(dir, child));

    const res = await pop(dir, ['show', ls.direct[0].hash]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/E_MISSING/);
    expect(res.stderr).toContain(child);
    expect(res.stdout).toMatch(/<missing/); // 占位条目在视图里
  });

  it('show --doc exports the dangling pin verbatim; --json carries view.missing', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', '--json', JSON.stringify(PARENT)]);
    const ls = JSON.parse((await pop(dir, ['ls', '--json'])).stdout);
    const child = ls.indirect.find((n: { name: string }) => n.name === 'Boil water').hash as string;
    fs.unlinkSync(nodeFile(dir, child));

    const doc = JSON.parse((await pop(dir, ['show', ls.direct[0].hash, '--doc'])).stdout);
    const pins = doc.children.filter((c: Record<string, unknown>) => Object.keys(c).length === 1 && 'hash' in c);
    expect(pins).toEqual([{ hash: child }]);

    const json = JSON.parse((await pop(dir, ['show', ls.direct[0].hash, '--json'])).stdout);
    expect(json.missing.map((m: { hash: string }) => m.hash)).toContain(child);
  });
});
