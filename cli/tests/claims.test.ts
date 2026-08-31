import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createdRoot, editedRoots, init, nodeFile, pop, readState, stateFile, tempDataDir, writeDoc } from './helpers.js';

const ACTION = { name: 'Boil water', content: 'Heat the drinking water to boiling.' };

// 认领时刻（collapsed reflog）：时间不属于内容寻址的节点，属于引用内容的认领事件
// ——state.claims 侧挂盖戳，saveState 修剪孤儿。详见 state.ts 的 claimDirect。
describe('claim timestamps in practi.json', () => {
  it('practi new stamps claims[hash]; re-creating the same doc keeps the first stamp', async () => {
    const dir = tempDataDir();
    await init(dir);

    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);
    expect(readState(dir).claims?.[root]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 幂等路径：认领已在列 → 不重盖。把戳改成可识别的旧值再跑同内容的 new，值应原样保留
    const tampered = readState(dir);
    tampered.claims![root] = '2001-01-01T00:00:00.000Z';
    fs.writeFileSync(stateFile(dir), JSON.stringify(tampered, null, 2) + '\n');

    const again = await pop(dir, ['new', '--json', JSON.stringify(ACTION)]);
    expect(again.code).toBe(0);
    expect(readState(dir).claims?.[root]).toBe('2001-01-01T00:00:00.000Z');
  });

  it('edit swaps the claim: new root stamped, orphaned old stamp pruned on save', async () => {
    const dir = tempDataDir();
    await init(dir);

    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);
    const edit = await pop(dir, ['edit', root, writeDoc(dir, { name: 'Boil water', content: 'v2' })]);
    expect(edit.code).toBe(0);
    const { oldRoot, newRoot } = editedRoots(edit.stdout);

    const state = readState(dir);
    expect(state.claims?.[oldRoot]).toBeUndefined();
    expect(state.claims?.[newRoot]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('practi repair backfills stripped stamps from node file mtime; stamped claims are never touched', async () => {
    const dir = tempDataDir();
    await init(dir);

    const root = createdRoot((await pop(dir, ['new', '--json', JSON.stringify(ACTION)])).stdout);
    // 剥掉 claims 表模拟老数据（claims 机制出现前认领的）
    const stripped = readState(dir);
    delete stripped.claims;
    fs.writeFileSync(stateFile(dir), JSON.stringify(stripped, null, 2) + '\n');

    const expected = fs.statSync(nodeFile(dir, root)).mtime.toISOString();
    const r = await pop(dir, ['repair']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/backfilled from file time/);
    expect(readState(dir).claims?.[root]).toBe(expected);

    // 幂等且不覆盖：已有戳（哪怕是手工改的旧值）重跑 repair 原样保留
    const tampered = readState(dir);
    tampered.claims![root] = '2001-01-01T00:00:00.000Z';
    fs.writeFileSync(stateFile(dir), JSON.stringify(tampered, null, 2) + '\n');
    const again = await pop(dir, ['repair']);
    expect(again.code).toBe(0);
    expect(readState(dir).claims?.[root]).toBe('2001-01-01T00:00:00.000Z');
  });
});
