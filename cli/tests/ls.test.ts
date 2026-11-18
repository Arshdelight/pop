import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIn, tempDataDir, writeDoc } from './helpers.js';

/**
 * practi ls：practices 家目录跨实践概览（新语义，2026-11-18 恢复）。
 * 纯本地零网络：家目录扫描 + chain.json 读取；unpushed = pushedAt 缺失数
 *（模拟推送 = 手改 chain.json 补戳，不引入 hub mock）。
 */

const DOC_A = { name: 'alpha', description: 'first', children: [{ name: 's1', content: 'step one', outputs: [{ name: 'o1', spec: 'ok' }] }] };
const DOC_B = { name: 'beta', description: 'second', children: [{ name: 's1', content: 'another step', outputs: [{ name: 'o1', spec: 'ok' }] }] };

async function newPractice(parent: string, home: string, name: string, doc: unknown, msg: string): Promise<void> {
  const base = writeDoc(parent, `${name}-base.json`, doc);
  const out = await runIn(parent, home, ['new', name, '--base', base, '-m', msg]);
  expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
}

/** 模拟「已推送」：全链补 pushedAt（不引 hub mock——ls 不联网，戳即事实源） */
function markPushed(home: string, name: string): void {
  const chainPath = path.join(home, 'practices', name, '.practi', 'chain.json');
  const chain = JSON.parse(fs.readFileSync(chainPath, 'utf8')) as { commits: { pushedAt?: string }[] };
  for (const c of chain.commits) c.pushedAt = new Date().toISOString();
  fs.writeFileSync(chainPath, JSON.stringify(chain, null, 2));
}

describe('practi ls：家目录跨实践概览', () => {
  it('列全部实践；unpushed 计数（未推=全部、已推=0 显 -）；--json 机器可读', async () => {
    const home = tempDataDir();
    const parent = tempDataDir();
    await newPractice(parent, home, 'alpha', DOC_A, 'a1');
    await newPractice(parent, home, 'beta', DOC_B, 'b1');
    // 实践是散落文件夹（new 生成在 parent）；ls 扫家目录 practices/ 聚居地——挪进去
    fs.mkdirSync(path.join(home, 'practices'), { recursive: true });
    fs.renameSync(path.join(parent, 'alpha'), path.join(home, 'practices', 'alpha'));
    fs.renameSync(path.join(parent, 'beta'), path.join(home, 'practices', 'beta'));
    // beta 补一版未推提交（两版、全未推）；alpha 标已推（0 未推）
    const betaDir = path.join(home, 'practices', 'beta');
    writeDoc(betaDir, 'beta.json', { ...DOC_B, description: 'second, revised' });
    const commit2 = await runIn(betaDir, home, ['commit', '-m', 'b2']);
    expect(commit2.code, `stdout=${commit2.stdout} stderr=${commit2.stderr}`).toBe(0);
    markPushed(home, 'alpha');

    const out = await runIn(parent, home, ['ls']);
    expect(out.code, `stdout=${out.stdout} stderr=${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/name\s+branch\s+head\s+revs\s+unpushed/);
    const alphaRow = out.stdout.split('\n').find((l) => l.startsWith('alpha'));
    const betaRow = out.stdout.split('\n').find((l) => l.startsWith('beta'));
    expect(alphaRow).toMatch(/\s1\s+-$/); // 1 版、未推 0 → '-'
    expect(betaRow).toMatch(/\s2\s+2$/); // 2 版全未推

    const json = JSON.parse((await runIn(parent, home, ['ls', '--json'])).stdout) as {
      name: string; branch: string; revisions: number; unpushed: number; head: string | null;
    }[];
    expect(json.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(json.find((e) => e.name === 'alpha')).toMatchObject({ revisions: 1, unpushed: 0 });
    expect(json.find((e) => e.name === 'beta')).toMatchObject({ revisions: 2, unpushed: 2, head: expect.stringMatching(/^sha256:/) });
  });

  it('空家目录/未 init：空态提示不炸（exit 0）', async () => {
    const home = tempDataDir();
    const out = await runIn(home, home, ['ls']);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/no practices/);
  });
});
