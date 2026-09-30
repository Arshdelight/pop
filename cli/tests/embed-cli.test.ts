import { describe, expect, it } from 'vitest';
import { createdRoot, init, pop, tempDataDir, writeDoc } from './helpers.js';

/**
 * `practi embed` 与 `search --semantic` 的**可选层**行为。
 *
 * 这一层最重要的性质不是"能用"，而是**缺了也要照常工作**：没下模型时 practi 是纯词法，
 * 而且必须**说出来**——少召回而不吭声是这类功能最坏的失败模式。
 * （真实模型的端到端验收在 docs/eval/production-acceptance.mjs，需要 24MB 下载。）
 */
describe('practi embed: optional vector layer', () => {
  it('reports the model as not ready, without failing', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['embed', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NOT ready');
    expect(r.stdout).toContain('vocab.txt: missing');
    expect(r.stdout).toContain('practi embed pull');
    expect(r.stdout).toContain('fingerprint:');
  });

  it('--json exposes the same facts in machine form', async () => {
    const dir = tempDataDir();
    await init(dir);
    const body = JSON.parse((await pop(dir, ['embed', 'status', '--json'])).stdout);
    expect(body.model.present).toBe(false);
    expect(body.model.bad.map((b: { reason: string }) => b.reason)).toEqual(['missing', 'missing']);
    expect(body.vectors.nodes).toBe(0);
    expect(typeof body.fingerprint).toBe('string');
  });

  it('refuses to build without a model, and says how to fix it', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Anything', content: 'body text here' })]);
    const r = await pop(dir, ['embed', 'build']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not ready');
    expect(r.stderr).toContain('practi embed pull');
  });

  it('prune is a no-op when there are no buckets', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['embed', 'prune']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing to prune');
  });

  it('explains itself when called without a subcommand', async () => {
    const dir = tempDataDir();
    await init(dir);
    const r = await pop(dir, ['embed']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('practi embed status|pull|build|prune');
  });
});

describe('practi search --semantic without a model', () => {
  it('still answers from the lexical index, and says the flag was ignored', async () => {
    const dir = tempDataDir();
    await init(dir);
    const root = createdRoot((await pop(dir, ['new', writeDoc(dir, { name: 'Kimchi stew', content: 'ferment cabbage' })])).stdout);

    const r = await pop(dir, ['search', 'kimchi', '--semantic']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew'); // 词法结果照常
    expect(r.stdout).toContain(root.slice(7, 19));
    expect(r.stderr).toContain('--semantic ignored');
    expect(r.stderr).toContain('embed pull');
    expect(r.stdout).not.toContain('fused with vector recall');
  });

  it('keeps --json machine-readable and puts the note on stderr', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Solo doc', content: 'x' })]);
    const r = await pop(dir, ['search', 'solo', '--semantic', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout); // stdout 必须是纯 JSON
    expect(body.results).toHaveLength(1);
    expect(body.results[0].vectorScore).toBeUndefined();
    expect(r.stderr).toContain('--semantic ignored');
  });

  it('mentions --semantic in the zero-hit next steps', async () => {
    const dir = tempDataDir();
    await init(dir);
    await pop(dir, ['new', writeDoc(dir, { name: 'Kimchi stew', content: 'ferment cabbage' })]);
    const r = await pop(dir, ['search', 'zzz-no-such-thing']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--semantic');
  });
});
