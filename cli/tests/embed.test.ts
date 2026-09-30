import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BertWordPieceTokenizer } from '../src/embed/tokenizer.js';
import {
  DEFAULT_MODEL,
  fakeEmbedder,
  modelFingerprint,
  modelStatus,
  pullModel,
  sha256File,
  type ModelSpec,
} from '../src/embed/model.js';
import {
  buildVectorIndex,
  cosine,
  listVectorBuckets,
  pruneVectorBuckets,
  rankByVector,
  readVectorIndex,
  vectorFilePath,
  writeVectorIndex,
} from '../src/embed/cache.js';
import { fuseRankings } from '../src/retrieval.js';

const sha256Of = (s: string): string => createHash('sha256').update(s).digest('hex');

/* ───────────────────────── 分词 ───────────────────────── */

/** 合成词表：结构测试不需要真词表 */
const tiny = BertWordPieceTokenizer.fromVocabText([
  '[PAD]', '[UNK]', '[CLS]', '[SEP]',
  'hello', 'world', '##s', 'he', '##llo',
  '断', '点', '续', '传', '怎', '么', '用',
  '断点', '点续', '续传',
].join('\n'));

describe('BertWordPieceTokenizer', () => {
  it('wraps the text in [CLS]/[SEP]', () => {
    const ids = tiny.encode('hello');
    expect(ids[0]).toBe(tiny.vocab.get('[CLS]'));
    expect(ids[ids.length - 1]).toBe(tiny.vocab.get('[SEP]'));
  });

  it('splits CJK per character (BERT tokenize_chinese_chars)', () => {
    expect(tiny.encode('断点')).toEqual([2, 9, 10, 3]); // 断 点
  });

  it('splits CJK per character before matching, so a CJK bigram in the vocab is never reached', () => {
    // tokenize_chinese_chars 先给每个汉字加空格 → 每个字是**独立的 basic token**，
    // 于是词表里即使有「断点」这个 bigram，也永远不会被贪心匹配选中。
    // （这一点容易想当然：中文 BERT 词表里的多字条目是给别的分词模式准备的。）
    expect(tiny.encode('断点')).toEqual([2, 9, 10, 3]);
    expect(tiny.encode('断点续')).toEqual([2, 9, 10, 11, 3]);
  });

  it('uses greedy longest-match with ## continuation for latin words', () => {
    expect(tiny.encode('hello')).toEqual([2, 4, 3]);
    expect(tiny.encode('hellos')).toEqual([2, 4, 6, 3]); // hello + ##s
  });

  it('falls back to [UNK] for a word that cannot be matched, and truncates at maxLength', () => {
    expect(tiny.encode('zzzz')).toEqual([2, 1, 3]);
    const short = BertWordPieceTokenizer.fromVocabText(
      ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '断', '点'].join('\n'),
      { maxLength: 5 },
    );
    const ids = short.encode('断点断点断点断点');
    expect(ids).toHaveLength(5); // 截到上限
    expect(ids[0]).toBe(2);
    expect(ids[4]).toBe(3); // 结尾仍是 [SEP]
  });

  it('splits punctuation into its own token and pads batches to equal width', () => {
    const ids = tiny.encode('hello, world');
    expect(ids).toContain(tiny.vocab.get('hello'));
    expect(ids).toContain(tiny.vocab.get('world'));
    const { ids: rows, mask } = tiny.padBatch([tiny.encode('hello'), tiny.encode('hello world')]);
    expect(rows[0]).toHaveLength(rows[1].length);
    expect(mask[0].reduce((a, b) => a + b, 0)).toBeLessThan(mask[1].reduce((a, b) => a + b, 0));
    expect(rows[0].every((v, i) => v !== 0 || mask[0][i] === 0)).toBe(true);
  });

  it('does not lowercase by default (this model is do_lower_case=false)', () => {
    const cased = BertWordPieceTokenizer.fromVocabText(['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'Hello', 'hello'].join('\n'));
    expect(cased.encode('Hello')).toEqual([2, 4, 3]);
    expect(cased.encode('HELLO')).toEqual([2, 1, 3]); // 大小写不同 → 词表里没有 → [UNK]
  });
});

/**
 * 与 HF `AutoTokenizer` 的逐位对账（token id 完全一致）。
 * 只有真实词表在场时才跑——CI 里不下 24MB 模型，本地有就顺带验一遍。
 */
const modelDirCandidates = [
  process.env.PRACTI_TEST_MODEL_DIR,
  path.join(os.homedir(), '.practi', 'models', 'bge-small-zh-v1.5'),
  path.join(os.tmpdir(), 'practi-model-spike'),
].filter((p): p is string => typeof p === 'string');
const realVocab = modelDirCandidates
  .map((d) => path.join(d, 'vocab.txt'))
  .find((p) => fs.existsSync(p));

describe.skipIf(realVocab === undefined)('tokenizer vs HF (needs the real vocab)', () => {
  it('reproduces the reference token ids exactly', () => {
    const tok = BertWordPieceTokenizer.fromVocabFile(realVocab!);
    // 期望值来自 HF AutoTokenizer 的对账夹具（docs/eval/reconcile-fixture.json）
    expect(tok.encode('断点续传怎么用')).toEqual([101, 3171, 4157, 5330, 837, 2582, 720, 4500, 102]);
    expect(tok.encode('科学上网')).toEqual([101, 4906, 2110, 677, 5381, 102]);
    expect(tok.encode('A short English sentence.')).toEqual([101, 100, 11167, 10143, 100, 9342, 8511, 10504, 119, 102]);
  });
});

/* ───────────────────────── 模型指纹与状态 ───────────────────────── */

describe('model fingerprint', () => {
  it('is stable for the same spec and changes when anything that affects vectors changes', () => {
    const base = modelFingerprint(DEFAULT_MODEL);
    expect(modelFingerprint(DEFAULT_MODEL)).toBe(base);
    const tweak = (patch: Partial<ModelSpec>): string => modelFingerprint({ ...DEFAULT_MODEL, ...patch });
    expect(tweak({ dim: 256 })).not.toBe(base);
    expect(tweak({ pooling: 'mean' as 'cls' })).not.toBe(base);
    expect(tweak({ maxLength: 256 })).not.toBe(base);
    expect(tweak({ queryPrefix: 'other' })).not.toBe(base);
    expect(modelFingerprint({
      ...DEFAULT_MODEL,
      files: DEFAULT_MODEL.files.map((f, i) => (i === 0 ? { ...f, sha256: 'deadbeef' } : f)),
    })).not.toBe(base);
  });

  it('reports a missing model instead of pretending', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practi-nomodel-'));
    const st = modelStatus(dir);
    expect(st.present).toBe(false);
    expect(st.bad.map((b) => b.reason)).toEqual(['missing', 'missing']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a download whose bytes do not match the pinned hash', async () => {
    // 本地起一个说假话的"模型仓"：完整性校验必须在写入前拦住它
    const served: string[] = [];
    const server = http.createServer((req, res) => {
      served.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('this is definitely not the model');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practi-badpull-'));
    const spec: ModelSpec = {
      ...DEFAULT_MODEL,
      files: [{ file: 'vocab.txt', remote: 'vocab.txt', sha256: 'not-the-real-hash', bytes: 33 }],
    };
    try {
      await expect(pullModel(dir, { spec, baseUrl: `http://127.0.0.1:${port}` }))
        .rejects.toThrow(/sha256 mismatch/);
      expect(served[0]).toContain('/resolve/main/vocab.txt');
      // 拒绝落盘：坏字节不能留在工作区里冒充模型
      expect(fs.existsSync(path.join(dir, 'models', spec.id, 'vocab.txt'))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files that are already present and correct (no re-download)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practi-skip-'));
    const body = 'abc';
    const spec: ModelSpec = {
      ...DEFAULT_MODEL,
      files: [{ file: 'vocab.txt', remote: 'vocab.txt', sha256: sha256Of(body), bytes: body.length }],
    };
    fs.mkdirSync(path.join(dir, 'models', spec.id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'models', spec.id, 'vocab.txt'), body);
    expect(modelStatus(dir, spec).present).toBe(true);
    // baseUrl 指向一个必然连不上的地址：只要它被访问就一定失败，从而证明"没去下载"
    const r = await pullModel(dir, { spec, baseUrl: 'http://127.0.0.1:1' });
    expect(r.skipped).toEqual(['vocab.txt']);
    expect(r.downloaded).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ───────────────────────── 向量缓存 ───────────────────────── */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'practi-vec-'));
}

describe('vector cache', () => {
  it('round-trips an index through disk', () => {
    const dir = tempDir();
    const dim = 4;
    const vectors = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]);
    writeVectorIndex(dir, {
      fingerprint: 'fp1', model: 'fake', dim, pooling: 'cls', count: 2,
      hashes: ['sha256:aaa', 'sha256:bbb'], vectors,
    });
    const back = readVectorIndex(dir, 'fp1')!;
    expect(back.count).toBe(2);
    expect(back.hashes).toEqual(['sha256:aaa', 'sha256:bbb']);
    expect(Array.from(back.vectors)).toEqual(Array.from(vectors));
    expect(back.rowOf.get('sha256:bbb')).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a wrong fingerprint, a missing file, or a corrupted body', () => {
    const dir = tempDir();
    writeVectorIndex(dir, {
      fingerprint: 'fp1', model: 'fake', dim: 4, pooling: 'cls', count: 1,
      hashes: ['sha256:aaa'], vectors: new Float32Array([1, 0, 0, 0]),
    });
    expect(readVectorIndex(dir, 'other')).toBeNull();
    expect(readVectorIndex(dir, 'nope')).toBeNull();
    fs.writeFileSync(vectorFilePath(dir, 'fp1'), 'PVEC1\ngarbage');
    expect(readVectorIndex(dir, 'fp1')).toBeNull(); // 坏文件当作没有，宁可重建
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('embeds only new hashes and reuses the rest (incremental build)', async () => {
    const dir = tempDir();
    const embedder = fakeEmbedder(8, 'fp-inc');
    const first = await buildVectorIndex({
      dataDir: dir, embedder,
      docs: [{ hash: 'sha256:a', text: 'alpha' }, { hash: 'sha256:b', text: 'beta' }],
    });
    expect(first.embedded).toBe(2);
    expect(first.reused).toBe(0);

    const second = await buildVectorIndex({
      dataDir: dir, embedder,
      docs: [
        { hash: 'sha256:a', text: 'alpha' },
        { hash: 'sha256:b', text: 'beta' },
        { hash: 'sha256:c', text: 'gamma' },
      ],
    });
    expect(second.embedded).toBe(1); // 只有 c 是新的
    expect(second.reused).toBe(2);
    expect(second.index.count).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops entries whose node left the workspace', async () => {
    const dir = tempDir();
    const embedder = fakeEmbedder(8, 'fp-drop');
    await buildVectorIndex({ dataDir: dir, embedder, docs: [{ hash: 'sha256:a', text: 'a' }, { hash: 'sha256:b', text: 'b' }] });
    const r = await buildVectorIndex({ dataDir: dir, embedder, docs: [{ hash: 'sha256:a', text: 'a' }] });
    expect(r.dropped).toBe(1);
    expect(r.index.count).toBe(1);
    expect(readVectorIndex(dir, 'fp-drop')!.hashes).toEqual(['sha256:a']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is byte-deterministic for the same input', async () => {
    const embedder = fakeEmbedder(8, 'fp-det');
    const docs = [{ hash: 'sha256:b', text: 'beta' }, { hash: 'sha256:a', text: 'alpha' }];
    const d1 = tempDir();
    const d2 = tempDir();
    await buildVectorIndex({ dataDir: d1, embedder, docs });
    await buildVectorIndex({ dataDir: d2, embedder, docs });
    expect(fs.readFileSync(vectorFilePath(d1, 'fp-det')).equals(fs.readFileSync(vectorFilePath(d2, 'fp-det')))).toBe(true);
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  });

  it('keeps one bucket per model fingerprint — that is how a model swap recomputes', async () => {
    const dir = tempDir();
    await buildVectorIndex({ dataDir: dir, embedder: fakeEmbedder(8, 'old-model'), docs: [{ hash: 'sha256:a', text: 'a' }] });
    await buildVectorIndex({ dataDir: dir, embedder: fakeEmbedder(8, 'new-model'), docs: [{ hash: 'sha256:a', text: 'a' }] });
    expect(listVectorBuckets(dir).map((b) => b.fingerprint)).toEqual(['new-model', 'old-model']);
    // 旧桶不会被读到（指纹不符），换模型即换桶 → 自动重算，无需迁移
    expect(readVectorIndex(dir, 'new-model')).not.toBeNull();
    expect(pruneVectorBuckets(dir, 'new-model')).toEqual(['old-model']);
    expect(listVectorBuckets(dir)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('vector ranking', () => {
  it('ranks by cosine and breaks ties by hash', () => {
    const dim = 2;
    const index = {
      fingerprint: 'f', model: 'fake', dim, pooling: 'cls', count: 3,
      hashes: ['sha256:b', 'sha256:a', 'sha256:c'],
      vectors: new Float32Array([1, 0, 1, 0, 0, 1]),
      rowOf: new Map([['sha256:b', 0], ['sha256:a', 1], ['sha256:c', 2]]),
    };
    const ranked = rankByVector(index, new Float32Array([1, 0]));
    expect(ranked.map((r) => r.hash)).toEqual(['sha256:a', 'sha256:b', 'sha256:c']); // 同分 → hash 升序
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });
});

/* ───────────────────────── 融合排序 ───────────────────────── */

describe('fuseRankings (RRF)', () => {
  it('rewards agreement between the two lists', () => {
    const lexical = ['a', 'b', 'c'];
    const vector = ['c', 'b', 'd'];
    expect(fuseRankings([lexical, vector])).toEqual(['c', 'b', 'a', 'd']);
  });

  it('keeps a lexically invisible node when the vector list has it (the whole point)', () => {
    expect(fuseRankings([[], ['x', 'y']])).toEqual(['x', 'y']);
    expect(fuseRankings([['x'], []])).toEqual(['x']);
  });

  it('is deterministic and total', () => {
    const a = fuseRankings([['p', 'q'], ['q', 'p']]);
    const b = fuseRankings([['p', 'q'], ['q', 'p']]);
    expect(a).toEqual(b);
    expect(fuseRankings([[], []])).toEqual([]);
  });
});
