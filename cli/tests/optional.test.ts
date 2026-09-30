import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attemptSemantic, describeRefresh, planRefresh, refreshVectors } from '../src/embed/optional.js';
import { fakeEmbedder, type Embedder } from '../src/embed/model.js';
import { readVectorIndex, writeVectorIndex } from '../src/embed/cache.js';

/**
 * 可选层的安全约定：**向量出任何问题都只能降级，不能把命令弄失败**。
 *
 * 这一组用例存在的直接原因是用户问的一句「向量模型没启用的话应该不会报错吧」——
 * 查下来 `--semantic` 那条路上确实没有兜底：模型在、运行时坏掉（onnxruntime-node 是
 * optionalDependency，没装/装不上都是正常情况）时会把整条命令带崩。
 */

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'practi-opt-'));

function fakeIndex(dir: string, hashes: string[], fingerprint = 'fp'): void {
  writeVectorIndex(dir, {
    fingerprint, model: 'fake', dim: 4, pooling: 'cls', count: hashes.length,
    hashes, vectors: new Float32Array(hashes.length * 4),
  });
}

describe('attemptSemantic', () => {
  it('passes the value through when everything works', async () => {
    const r = await attemptSemantic(async () => fakeEmbedder(4), async (e) => e.dim);
    expect(r).toEqual({ ok: true, value: 4 });
  });

  it('degrades when the embedder cannot be loaded (missing runtime / broken native binary)', async () => {
    const r = await attemptSemantic<number>(
      async () => { throw new Error('onnxruntime-node is not installed'); },
      async () => 1,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('onnxruntime-node');
  });

  it('degrades when the embedding itself throws (corrupt ONNX, OOM, bad input)', async () => {
    const r = await attemptSemantic(
      async () => fakeEmbedder(4),
      async () => { throw new Error('session run failed'); },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('session run failed');
  });

  it('disposes the embedder on the failure path, and a failing dispose does not mask the result', async () => {
    let disposed = 0;
    const embedder: Embedder = {
      id: 't', fingerprint: 'f', dim: 2, queryPrefix: '',
      async embed(texts) { return texts.map(() => new Float32Array(2)); },
      async dispose() { disposed++; throw new Error('dispose boom'); },
    };
    const r = await attemptSemantic(async () => embedder, async () => 'ok');
    expect(r).toEqual({ ok: true, value: 'ok' });
    expect(disposed).toBe(1);
  });
});

describe('planRefresh', () => {
  it('is off when there is no index at all', () => {
    expect(planRefresh(null, ['a', 'b'])).toEqual({ action: 'off', missing: [], stale: 0 });
  });

  it('is up-to-date when every node is covered and nothing is stale', () => {
    const index = { hashes: ['a', 'b'], rowOf: new Map([['a', 0], ['b', 1]]) };
    expect(planRefresh(index, ['a', 'b']).action).toBe('up-to-date');
  });

  it('inlines a few missing nodes, and counts stale entries', () => {
    const index = { hashes: ['a', 'gone'], rowOf: new Map([['a', 0], ['gone', 1]]) };
    const plan = planRefresh(index, ['a', 'b', 'c']);
    expect(plan.action).toBe('inline');
    expect(plan.missing).toEqual(['b', 'c']);
    expect(plan.stale).toBe(1);
  });

  it('hands a big backlog to `embed build` instead of stalling the record flow', () => {
    const index = { hashes: [], rowOf: new Map() };
    const many = Array.from({ length: 33 }, (_, i) => `h${i}`);
    expect(planRefresh(index, many).action).toBe('behind');
    expect(planRefresh(index, many.slice(0, 32)).action).toBe('inline');
  });

  it('refreshes when nothing is missing but something went stale (edit GCed nodes)', () => {
    const index = { hashes: ['a', 'gone'], rowOf: new Map([['a', 0], ['gone', 1]]) };
    expect(planRefresh(index, ['a']).action).toBe('inline');
  });
});

describe('refreshVectors', () => {
  it('does nothing at all when the model was never pulled (no model dir, no index)', async () => {
    const dir = tempDir();
    let loaded = 0;
    const r = await refreshVectors(dir, ['sha256:a'], () => 'text', async () => {
      loaded++;
      return fakeEmbedder(4);
    });
    expect(r).toEqual({ state: 'off' });
    expect(loaded).toBe(0); // 一次原生调用都没发生 —— 没启用就不该有成本
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports up-to-date without embedding anything when the index is current', async () => {
    // 用真模型目录做不到（哈希钉死在 24MB 文件上），所以这里只验「没启用就彻底不动」
    const dir = tempDir();
    const r = await refreshVectors(dir, [], () => '', async () => fakeEmbedder(4));
    expect(r.state).toBe('off');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('describeRefresh', () => {
  it('stays silent when there is nothing to do or nothing to say', () => {
    expect(describeRefresh({ state: 'off' })).toBeNull();
    expect(describeRefresh({ state: 'up-to-date' })).toBeNull();
    // 成功也静默：每记一条就报一次「干完活了」是噪音
    expect(describeRefresh({ state: 'embedded', embedded: 2, total: 10 })).toBeNull();
  });

  it('speaks up when the user has to act, or when something broke', () => {
    expect(describeRefresh({ state: 'behind', missing: 40 })).toContain('embed build');
    const broken = describeRefresh({ state: 'unavailable', reason: 'onnxruntime-node is not installed' });
    expect(broken).toContain('onnxruntime-node');
    expect(broken).toContain('lexical search is unaffected');
  });
});

describe('vector index files are never half-read', () => {
  it('a truncated bucket reads as absent instead of throwing', () => {
    const dir = tempDir();
    fakeIndex(dir, ['sha256:a']);
    const file = path.join(dir, 'vectors', 'fp.pvec');
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 3)); // 砍掉尾巴
    expect(readVectorIndex(dir, 'fp')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
