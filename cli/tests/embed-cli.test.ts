import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, init, runIn, tempDataDir, writeDoc } from './helpers.js';

/**
 * `practi embed` 与 `search --semantic` 的**可选层**行为。
 *
 * 这一层最重要的性质不是"能用"，而是**缺了也要照常工作**：没下模型时 practi 是纯词法，
 * 而且必须**说出来**——少召回而不吭声是这类功能最坏的失败模式。
 * 文件夹模型下模型/向量目录挂在本实例的 .practi/（.practi/models、.practi/vectors）。
 * （真实模型的端到端验收在 docs/eval/production-acceptance.mjs，需要 24MB 下载。）
 */

const SEED = { name: 'Kimchi stew', description: 'a seeded practice', content: 'ferment cabbage and simmer it slowly.' };

/** 带首版修订的实例文件夹 */
async function setup(doc: Record<string, unknown> = SEED): Promise<{ home: string; repo: string; root: string }> {
  const home = tempDataDir();
  await init(home);
  const parent = tempDataDir();
  await runIn(parent, home, ['new', 'my-practice', '--base', writeDoc(parent, 'seed.json', doc)]);
  const repo = path.join(parent, 'my-practice');
  return { home, repo, root: chainOf(repo).commits[0]!.root };
}

/** 模型文件在位但内容是坏的（真实场景：下载被截断、磁盘坏块、手工放错文件） */
function brokenModel(repo: string): void {
  const modelDir = path.join(repo, '.practi', 'models', 'bge-small-zh-v1.5');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'vocab.txt'), 'not the real vocab');
  fs.writeFileSync(path.join(modelDir, 'model_quantized.onnx'), 'not the real model');
}

describe('practi embed: optional vector layer', () => {
  it('reports the model as not ready, without failing', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['embed', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NOT ready');
    expect(r.stdout).toContain('vocab.txt: missing');
    expect(r.stdout).toContain('practi embed pull');
    expect(r.stdout).toContain('fingerprint:');
  });

  it('--json exposes the same facts in machine form', async () => {
    const { home, repo } = await setup();
    const body = JSON.parse((await runIn(repo, home, ['embed', 'status', '--json'])).stdout);
    expect(body.model.present).toBe(false);
    expect(body.model.dir).toContain(path.join('.practi', 'models')); // 模型挂实例池
    expect(body.model.bad.map((b: { reason: string }) => b.reason)).toEqual(['missing', 'missing']);
    expect(body.vectors.nodes).toBe(1); // 池里已有首版节点
    expect(typeof body.fingerprint).toBe('string');
  });

  it('refuses to build without a model, and says how to fix it', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['embed', 'build']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not ready');
    expect(r.stderr).toContain('practi embed pull');
  });

  it('prune is a no-op when there are no buckets', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['embed', 'prune']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing to prune');
  });

  it('explains itself when called without a subcommand', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['embed']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('practi embed status|pull|build|prune');
  });
});

describe('practi search --semantic without a model', () => {
  it('still answers from the lexical index, and says the flag was ignored', async () => {
    const { home, repo, root } = await setup();

    const r = await runIn(repo, home, ['search', 'kimchi', '--semantic']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew'); // 词法结果照常
    expect(r.stdout).toContain(root.slice(7, 19));
    expect(r.stderr).toContain('--semantic ignored');
    expect(r.stderr).toContain('embed pull');
    expect(r.stdout).not.toContain('fused with vector recall');
  });

  it('keeps --json machine-readable and puts the note on stderr', async () => {
    const { home, repo } = await setup({ name: 'Solo doc', content: 'x' });
    const r = await runIn(repo, home, ['search', 'solo', '--semantic', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout); // stdout 必须是纯 JSON
    expect(body.results).toHaveLength(1);
    expect(body.results[0].vectorScore).toBeUndefined();
    expect(r.stderr).toContain('--semantic ignored');
  });

  it('mentions --semantic in the zero-hit next steps', async () => {
    const { home, repo } = await setup();
    const r = await runIn(repo, home, ['search', 'zzz-no-such-thing']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--semantic');
  });
});

/**
 * 用户问过一句「向量模型没启用的话应该不会报错吧」——查下来 `--semantic` 那条路上
 * 确实没有兜底。这一组把「向量层出任何问题都只降级、不失败」钉在 CLI 层。
 */
describe('the vector layer can never break a command', () => {
  it('plain search never touches the vector layer at all', async () => {
    const { home, repo } = await setup();
    brokenModel(repo); // 模型坏着也不该有任何影响

    const r = await runIn(repo, home, ['search', 'kimchi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Kimchi stew');
    expect(r.stderr).toBe(''); // 连一句提示都不该有：没要求语义就别提它
  });

  it('--semantic with a broken model degrades with the reason, and still answers', async () => {
    const { home, repo } = await setup();
    brokenModel(repo);

    const r = await runIn(repo, home, ['search', 'kimchi', '--semantic']);
    expect(r.code).toBe(0); // 关键：不是 exit 1
    expect(r.stdout).toContain('Kimchi stew'); // 词法结果照常
    expect(r.stderr).toContain('--semantic ignored');
    expect(r.stderr).toMatch(/corrupt|not ready/);
  });

  it('embed build on a broken model fails loudly — that is an explicit request', async () => {
    const { home, repo } = await setup();
    brokenModel(repo);
    const r = await runIn(repo, home, ['embed', 'build']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not ready|corrupt/);
    expect(r.stderr).toContain('embed pull');
  });
});
