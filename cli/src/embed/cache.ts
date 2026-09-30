import fs from 'node:fs';
import path from 'node:path';
import type { Embedder } from './model.js';

/**
 * 向量缓存（工作区 sidecar，检索期派生物，绝不进节点、绝不参与 hash）。
 *
 * 文件布局 `<dataDir>/vectors/<指纹>.pvec`：
 *   "PVEC1\n" | uint32LE 头部长度 | JSON 头部 | count×dim 个 float32LE
 * 头部带 count 与按升序排列的节点哈希，正文与之一一对应。
 *
 * **"模型更新后自动重算"就是靠文件名里的指纹**：指纹覆盖模型文件哈希、维度、
 * 池化方式、序列上限与分词器种类（见 model.ts）。换模型 = 换桶 = 自动重建，
 * 不需要任何迁移代码，也不可能误用旧向量。旧桶由 `practi embed prune` 清理。
 *
 * 复用粒度是**节点哈希**：内容寻址白送的语义——节点内容一变哈希就变，所以
 * 「这个哈希在旧缓存里」就等价于「这段内容已经嵌过」，不需要比时间戳或做 diff。
 */

const MAGIC = 'PVEC1\n';
const HEADER_OFFSET = MAGIC.length + 4;

export interface VectorIndex {
  fingerprint: string;
  model: string;
  dim: number;
  pooling: string;
  count: number;
  /** 升序排列的节点哈希，与 vectors 的行一一对应 */
  hashes: string[];
  /** count × dim，行主序、已 L2 归一化 */
  vectors: Float32Array;
  /** 哈希 → 行号 */
  rowOf: Map<string, number>;
}

export function vectorsDir(dataDir: string): string {
  return path.join(dataDir, 'vectors');
}

export function vectorFilePath(dataDir: string, fingerprint: string): string {
  return path.join(vectorsDir(dataDir), `${fingerprint}.pvec`);
}

export function writeVectorIndex(dataDir: string, index: Omit<VectorIndex, 'rowOf'>): void {
  const dir = vectorsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    schema: 1,
    fingerprint: index.fingerprint,
    model: index.model,
    dim: index.dim,
    pooling: index.pooling,
    count: index.count,
    hashes: index.hashes,
  });
  const headerBuf = Buffer.from(header, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  const body = Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength);
  const tmp = `${vectorFilePath(dataDir, index.fingerprint)}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(MAGIC, 'utf8'), lenBuf, headerBuf, body]));
  fs.renameSync(tmp, vectorFilePath(dataDir, index.fingerprint)); // 原子替换：半个文件不会被读到
}

/** 读缓存；缺失/损坏/指纹不符一律返回 null（调用方重建，绝不半信半疑地用） */
export function readVectorIndex(dataDir: string, fingerprint: string): VectorIndex | null {
  const file = vectorFilePath(dataDir, fingerprint);
  if (!fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) return null;
    const headerLen = buf.readUInt32LE(MAGIC.length);
    const header = JSON.parse(buf.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLen).toString('utf8')) as {
      fingerprint?: unknown; model?: unknown; dim?: unknown; pooling?: unknown; count?: unknown; hashes?: unknown;
    };
    if (header.fingerprint !== fingerprint) return null;
    if (typeof header.dim !== 'number' || typeof header.count !== 'number' || !Array.isArray(header.hashes)) return null;
    const dim = header.dim;
    const count = header.count;
    if (header.hashes.length !== count) return null;
    const bodyStart = HEADER_OFFSET + headerLen;
    const expected = count * dim * 4;
    if (buf.byteLength - bodyStart < expected) return null;
    const hashes = header.hashes.map(String);
    const vectors = new Float32Array(count * dim);
    for (let i = 0; i < count * dim; i++) vectors[i] = buf.readFloatLE(bodyStart + i * 4);
    const rowOf = new Map<string, number>();
    hashes.forEach((h, i) => rowOf.set(h, i));
    return {
      fingerprint,
      model: typeof header.model === 'string' ? header.model : '',
      dim,
      pooling: typeof header.pooling === 'string' ? header.pooling : '',
      count,
      hashes,
      vectors,
      rowOf,
    };
  } catch {
    return null; // 坏文件当作没有：宁可重建，也不用可疑的向量
  }
}

export interface BuildResult {
  index: VectorIndex;
  /** 这次真正嵌入的节点数 */
  embedded: number;
  /** 从旧缓存复用的节点数（内容没变） */
  reused: number;
  /** 被丢弃的陈旧条目数（节点已不在工作区） */
  dropped: number;
}

export interface BuildOptions {
  dataDir: string;
  embedder: Embedder;
  /** 当前工作区的全量节点：哈希 + 索引文本 */
  docs: readonly { hash: string; text: string }[];
  onProgress?: (done: number, total: number) => void;
}

/**
 * 建立/增量更新向量缓存。只嵌**缓存里没有的哈希**——这既是增量的依据，
 * 也是内容寻址的直接推论（同哈希 ⇒ 同内容 ⇒ 同向量）。
 */
export async function buildVectorIndex(opts: BuildOptions): Promise<BuildResult> {
  const { dataDir, embedder, docs } = opts;
  const previous = readVectorIndex(dataDir, embedder.fingerprint);

  // 目标集合按哈希升序固定下来：文件内容与行序都确定，两次构建逐字节一致
  const wanted = [...docs].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const wantedSet = new Set(wanted.map((d) => d.hash));

  const missing: { hash: string; text: string }[] = [];
  const reuseRows = new Map<string, number>();
  let dropped = 0;
  if (previous !== null && previous.dim === embedder.dim) {
    for (const h of previous.hashes) if (!wantedSet.has(h)) dropped++;
    for (const d of wanted) {
      const row = previous.rowOf.get(d.hash);
      if (row !== undefined) reuseRows.set(d.hash, row);
      else missing.push(d);
    }
  } else {
    missing.push(...wanted);
  }

  const fresh = new Map<string, Float32Array>();
  if (missing.length > 0) {
    const CHUNK = 32;
    let done = 0;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const slice = missing.slice(i, i + CHUNK);
      const vecs = await embedder.embed(slice.map((m) => m.text));
      slice.forEach((m, k) => fresh.set(m.hash, vecs[k]));
      done += slice.length;
      opts.onProgress?.(done, missing.length);
    }
  }

  const dim = embedder.dim;
  const hashes: string[] = [];
  const vectors = new Float32Array(wanted.length * dim);
  wanted.forEach((d, i) => {
    hashes.push(d.hash);
    const freshVec = fresh.get(d.hash);
    if (freshVec !== undefined) {
      vectors.set(freshVec.subarray(0, dim), i * dim);
      return;
    }
    const row = reuseRows.get(d.hash)!;
    vectors.set(previous!.vectors.subarray(row * dim, row * dim + dim), i * dim);
  });

  const index: VectorIndex = {
    fingerprint: embedder.fingerprint,
    model: embedder.id,
    dim,
    pooling: 'cls',
    count: wanted.length,
    hashes,
    vectors,
    rowOf: new Map(hashes.map((h, i) => [h, i])),
  };
  writeVectorIndex(dataDir, index);
  return { index, embedded: fresh.size, reused: reuseRows.size, dropped };
}

/** 余弦相似度（两侧都已归一化时就是点积；这里不假设，稳妥起见仍做归一） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** 目标向量 → 全库排序（分数降序、同分取 hash 升序，保证确定） */
export function rankByVector(index: VectorIndex, target: Float32Array): { hash: string; score: number }[] {
  const out: { hash: string; score: number }[] = [];
  const { dim } = index;
  for (let i = 0; i < index.count; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += index.vectors[base + d] * target[d];
    out.push({ hash: index.hashes[i], score: dot });
  }
  out.sort((a, b) => (b.score - a.score) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

/** 列出工作区里已存在的向量桶（`embed status` / `embed prune` 用） */
export function listVectorBuckets(dataDir: string): { fingerprint: string; bytes: number; mtime: string }[] {
  const dir = vectorsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pvec'))
    .sort()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { fingerprint: f.slice(0, -'.pvec'.length), bytes: st.size, mtime: st.mtime.toISOString() };
    });
}

/** 删掉非当前指纹的旧桶（模型换代后的清理） */
export function pruneVectorBuckets(dataDir: string, keep: string): string[] {
  const removed: string[] = [];
  for (const b of listVectorBuckets(dataDir)) {
    if (b.fingerprint === keep) continue;
    fs.unlinkSync(vectorFilePath(dataDir, b.fingerprint));
    removed.push(b.fingerprint);
  }
  return removed;
}
