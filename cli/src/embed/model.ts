import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BertWordPieceTokenizer } from './tokenizer.js';
import { fetchUrl } from '../net.js';

/**
 * 离线向量模型：可选下载 + 纯 JS 推理。
 *
 * 这是**可选层**：没装模型时 practi 完全照常工作（纯词法），装了才多一路语义召回。
 * 规格把语义排序明确划给 hub 侧（pop-spec §9.1：Vector/semantic ranking is a hub-side
 * enhancement, reserved but not part of the contract），所以本地这一层是**非规范**的：
 * 向量只落在工作区的 sidecar 里，绝不进节点、绝不参与 hash。
 *
 * 选型实测（772 节点真实语料，见 docs/discussion/2026-09-30-vector-recall-decision.md）：
 *  - 蒸馏静态表（唯一能"自带"的形态）2/9，且错误答案分数**更高**，没有阈值可用；
 *  - 真 transformer（本模块这条路）4/9，榜首正确，改用正确的 CLS pooling 后不再有
 *    "高分错答案"现象。所以只做可选下载，不做自带蒸馏表。
 */

export interface ModelFileSpec {
  /** 工作区内的相对路径（同时是模型仓里的路径后缀） */
  file: string;
  /** 模型仓里的路径 */
  remote: string;
  sha256: string;
  bytes: number;
}

export interface ModelSpec {
  id: string;
  repo: string;
  dim: number;
  /** bge v1.5 必须用 CLS（用 mean pooling 量出来的分数是错的） */
  pooling: 'cls';
  maxLength: number;
  /**
   * 只加在**查询**一侧的指令前缀。BGE 系列的非对称用法：文档侧不加、查询侧加，
   * 官方实测能明显拉开召回。它参与指纹，因为改前缀等于改查询向量。
   */
  queryPrefix: string;
  files: readonly ModelFileSpec[];
}

/** 固定的模型清单：版本、哈希、维度都钉死，指纹才有意义 */
export const DEFAULT_MODEL: ModelSpec = {
  id: 'bge-small-zh-v1.5',
  repo: 'Xenova/bge-small-zh-v1.5',
  dim: 512,
  pooling: 'cls',
  maxLength: 512,
  queryPrefix: '为这个句子生成表示以用于检索相关文章：',
  files: [
    {
      file: 'vocab.txt',
      remote: 'vocab.txt',
      sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
      bytes: 109540,
    },
    {
      file: 'model_quantized.onnx',
      remote: 'onnx/model_quantized.onnx',
      sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
      bytes: 24010842,
    },
  ],
};

/**
 * 模型指纹：向量缓存的桶名。**这就是"模型更新后自动重算"的实现方式**——
 * 指纹变了就是另一个缓存文件，旧向量不会被误用；也不需要任何迁移代码。
 * 覆盖全部会影响向量数值的东西：文件哈希、维度、池化、序列上限、分词器种类。
 */
export function modelFingerprint(spec: ModelSpec = DEFAULT_MODEL): string {
  const canonical = JSON.stringify({
    id: spec.id,
    repo: spec.repo,
    dim: spec.dim,
    pooling: spec.pooling,
    maxLength: spec.maxLength,
    queryPrefix: spec.queryPrefix,
    tokenizer: 'bert-wordpiece',
    lowerCase: false,
    files: spec.files.map((f) => ({ file: f.file, sha256: f.sha256 })).sort((a, b) => (a.file < b.file ? -1 : 1)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function modelDir(dataDir: string, spec: ModelSpec = DEFAULT_MODEL): string {
  return path.join(dataDir, 'models', spec.id);
}

export function modelFilePath(dataDir: string, file: string, spec: ModelSpec = DEFAULT_MODEL): string {
  return path.join(modelDir(dataDir, spec), file);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface ModelStatus {
  id: string;
  dir: string;
  present: boolean;
  /** 缺失或哈希不符的文件 */
  bad: { file: string; reason: 'missing' | 'corrupt' }[];
  bytes: number;
}

export function modelStatus(dataDir: string, spec: ModelSpec = DEFAULT_MODEL): ModelStatus {
  const dir = modelDir(dataDir, spec);
  const bad: { file: string; reason: 'missing' | 'corrupt' }[] = [];
  let bytes = 0;
  for (const f of spec.files) {
    const p = path.join(dir, f.file);
    if (!fs.existsSync(p)) {
      bad.push({ file: f.file, reason: 'missing' });
      continue;
    }
    const size = fs.statSync(p).size;
    bytes += size;
    if (size !== f.bytes || sha256File(p) !== f.sha256) bad.push({ file: f.file, reason: 'corrupt' });
  }
  return { id: spec.id, dir, present: bad.length === 0, bad, bytes };
}

export interface PullProgress {
  file: string;
  done: number;
  total: number;
}

export interface PullOptions {
  onProgress?: (p: PullProgress) => void;
  spec?: ModelSpec;
  /** 取件根地址（默认 HuggingFace）；留出这个口子是为了镜像/离线缓存，也让完整性校验可测 */
  baseUrl?: string;
}

/** 下载模型到工作区（缺哪个补哪个；已存在且哈希相符的跳过） */
export async function pullModel(dataDir: string, opts: PullOptions = {}): Promise<{ downloaded: string[]; skipped: string[] }> {
  const spec = opts.spec ?? DEFAULT_MODEL;
  const base = (opts.baseUrl ?? 'https://huggingface.co').replace(/\/$/, '');
  const dir = modelDir(dataDir, spec);
  fs.mkdirSync(dir, { recursive: true });
  const downloaded: string[] = [];
  const skipped: string[] = [];
  for (const f of spec.files) {
    const dest = path.join(dir, f.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes && sha256File(dest) === f.sha256) {
      skipped.push(f.file);
      continue;
    }
    const url = `${base}/${spec.repo}/resolve/main/${f.remote}`;
    const res = await fetchUrl(url, { maxBytes: f.bytes + 1024 });
    if (!res.ok) throw new Error(`download ${f.remote} → HTTP ${res.status}`);
    const got = createHash('sha256').update(res.bytes).digest('hex');
    if (got !== f.sha256) {
      throw new Error(`${f.file}: sha256 mismatch (expected ${f.sha256}, got ${got}) — refusing to store`);
    }
    fs.writeFileSync(dest, res.bytes);
    opts.onProgress?.({ file: f.file, done: res.bytes.length, total: f.bytes });
    downloaded.push(f.file);
  }
  return { downloaded, skipped };
}

/** 嵌入器：向量缓存与融合排序只依赖这个接口，测试可以塞确定性假实现 */
export interface Embedder {
  readonly fingerprint: string;
  readonly dim: number;
  readonly id: string;
  /** 只加在查询一侧的指令前缀（文档侧不加） */
  readonly queryPrefix: string;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

/** 每条文本一批的上限：模型只有 4 层，CPU 上 8 条一批最稳 */
const BATCH = 8;

/**
 * 真正的 ONNX 推理。`onnxruntime-node` 是 **optionalDependency**：没装时这里抛
 * 一个可读的错误，调用方降级为纯词法（绝不因为可选功能缺失而让整条命令挂掉）。
 */
export async function loadOnnxEmbedder(
  dataDir: string,
  spec: ModelSpec = DEFAULT_MODEL,
): Promise<Embedder> {
  const status = modelStatus(dataDir, spec);
  if (!status.present) {
    const missing = status.bad.map((b) => `${b.file} (${b.reason})`).join(', ');
    throw new Error(`model ${spec.id} is not ready in ${status.dir}: ${missing} — run \`practi embed pull\``);
  }
  let ort: typeof import('onnxruntime-node');
  try {
    ort = await import('onnxruntime-node');
  } catch {
    throw new Error(
      'the optional dependency "onnxruntime-node" is not installed — run `npm install -g @arshdelight/practi` ' +
      'with optional dependencies enabled, or use lexical search only',
    );
  }
  const tokenizer = BertWordPieceTokenizer.fromVocabFile(
    modelFilePath(dataDir, 'vocab.txt', spec),
    { maxLength: spec.maxLength, lowerCase: false },
  );
  const session = await ort.InferenceSession.create(modelFilePath(dataDir, 'model_quantized.onnx', spec));
  const inputIds = session.inputNames.includes('input_ids') ? 'input_ids' : session.inputNames[0];
  const outputName = session.outputNames[0];

  return {
    id: spec.id,
    fingerprint: modelFingerprint(spec),
    dim: spec.dim,
    queryPrefix: spec.queryPrefix,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const encoded = tokenizer.encodeBatch(batch);
        const { ids, mask } = tokenizer.padBatch(encoded);
        const n = batch.length;
        const width = ids[0].length;
        const i64 = new BigInt64Array(n * width);
        const m64 = new BigInt64Array(n * width);
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < width; c++) {
            i64[r * width + c] = BigInt(ids[r][c]);
            m64[r * width + c] = BigInt(mask[r][c]);
          }
        }
        const feeds: Record<string, unknown> = {
          [inputIds]: new ort.Tensor('int64', i64, [n, width]),
        };
        // 模型要几个输入就给几个（有的导出没有 token_type_ids）
        if (session.inputNames.includes('attention_mask')) {
          feeds.attention_mask = new ort.Tensor('int64', m64, [n, width]);
        }
        if (session.inputNames.includes('token_type_ids')) {
          feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * width), [n, width]);
        }
        const res = await session.run(feeds as never);
        const t = res[outputName];
        const dim = spec.dim;
        for (let r = 0; r < n; r++) {
          const v = new Float32Array(dim);
          let norm = 0;
          for (let d = 0; d < dim; d++) {
            const x = Number(t.data[r * width * dim + d]);
            v[d] = x;
            norm += x * x;
          }
          norm = Math.sqrt(norm);
          if (norm > 0) for (let d = 0; d < dim; d++) v[d] /= norm;
          out.push(v);
        }
      }
      return out;
    },
    async dispose() {
      await session.release?.();
    },
  };
}

/**
 * 确定性假嵌入器：**只给测试用**。
 * 用字符 bigram 做哈希散布再归一化——不是语义，但同文本必得同向量、相似文本得相似向量，
 * 足够驱动缓存与融合排序的逻辑测试，且不需要在 CI 里下 24MB 模型。
 */
export function fakeEmbedder(dim = 64, fingerprint = 'fake-fingerprint'): Embedder {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    const s = text.toLowerCase();
    for (let i = 0; i < s.length; i++) {
      const gram = s.slice(i, i + 2);
      let h = 2166136261;
      for (const ch of gram) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
      const idx = Math.abs(h) % dim;
      v[idx] += 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < dim; d++) v[d] /= norm;
    return v;
  };
  return {
    id: 'fake',
    fingerprint,
    dim,
    queryPrefix: '',
    async embed(texts) { return texts.map(vec); },
    async dispose() { /* nothing */ },
  };
}
