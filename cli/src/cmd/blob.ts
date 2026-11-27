import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { storeBlob } from '@arshdelight/pop-sdk';
import { resolveRepo } from '../practice.js';
import { fetchUrl } from '../net.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { uploadBlob } from '../client.js';
import { parseCloneRef } from './clone.js';

export interface BlobOpts {
  dir?: string;
  positional: string[];
  name?: string;
  /** 配置家（远程模式读凭据与 remote）；本地模式不用 */
  dataDir?: string;
}

/** 算好的附件条目（待粘贴进文档的 attachments） */
export interface BlobEntry {
  name: string;
  hash: string;
  mime: string;
  size: number;
}

/**
 * Stage an attachment and emit the ready-to-paste attachment entry.
 * - Local file: hashed + stored into the instance's blob channel (.practi/blobs),
 *   entry emitted without url.
 * - http(s) URL: fetched once (25MB cap), bytes ALSO stored into the instance's
 *   blob channel, entry emitted without url (2026-09-03 本地口径：指针纯 hash，
 *   bytes 一律走 .practi/blobs/<2hex>/<64hex> 内容寻址布局——url 只是导入途径，不进指针；
 *   spec §5 允许 url 字段，practi 不产生也不消费).
 * - `<owner>/<name> <file-or-url>`（两个位置参数且第一个带 /）：字节直接 PUT 上 hub，
 *   不落本地池——条目算法与本地完全一致（直连 hub 的写路径，2026-11-27）。
 *
 * Attachments are immutable content: the emitted entry goes into the author's
 * document JSON, never mutated onto an existing node.
 */
/** decodeURIComponent 的 URIError 兜底：a%zz 这类坏转义用原名 */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export async function runBlobAdd(opts: BlobOpts): Promise<number> {
  const target = opts.positional[0];
  if (!target) {
    console.error('usage: practi blob add <file-or-url> [--name <name>]   |   practi blob add <owner>/<name> <file-or-url> [--name <name>]   (straight to the hub)');
    return 1;
  }
  // 两个位置参数且第一个带 / = 直传 hub（地址只做合法性校验，不参与请求）
  if (target.includes('/') && opts.positional.length === 2) {
    const parsed = parseCloneRef(target);
    if (!parsed || parsed.owner === undefined) {
      console.error('error: a hub practice needs its owner — `practi blob add <owner>/<name> <file-or-url> [--name <name>]`');
      return 1;
    }
    const dataDir = opts.dataDir ?? defaultDataDir();
    const remote = remoteUrl(dataDir);
    return opts.positional[1]!.match(/^https?:\/\//i)
      ? blobFromUrl(opts.positional[1]!, opts.name, { dataDir, remote })
      : blobFromFile(opts.positional[1]!, opts.name, { dataDir, remote });
  }
  const repo = resolveRepo({ dir: opts.dir, verb: 'blob add' });
  if (repo === null) return 1;
  if (/^https?:\/\//i.test(target)) return blobFromUrl(target, opts.name, { poolDir: repo.poolDir });
  return blobFromFile(target, opts.name, { poolDir: repo.poolDir });
}

/** 算条目（不落池）：本地与远程共用 */
function entryFromFile(target: string, name: string | undefined): { entry: BlobEntry; bytes: Buffer } {
  const bytes = fs.readFileSync(target);
  const base = path.basename(target);
  const hash = sha256(bytes);
  return {
    entry: { name: name ?? base, hash, mime: mimeFromName(base), size: bytes.length },
    bytes,
  };
}

const MAX_URL_BYTES = 25 * 1024 * 1024;

async function entryFromUrl(url: string, name: string | undefined): Promise<{ entry: BlobEntry; bytes: Buffer }> {
  // 走 net.ts 而不是全局 fetch：有系统代理的机器上 fetch 会直接 "fetch failed"
  // （Node 的 undici 不读 Windows 注册表代理）——实测复现过的真实故障
  const res = await fetchUrl(url, { maxBytes: MAX_URL_BYTES });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const contentType = res.contentType;
  const bytes = res.bytes;
  let base = '';
  try {
    base = path.posix.basename(new URL(url).pathname);
  } catch {
    base = '';
  }
  const mimeExt = mimeFromName(base);
  return {
    entry: {
      name: name ?? (base && base !== '/' ? safeDecode(base) : 'attachment'),
      hash: sha256(bytes),
      mime: contentType && contentType !== 'application/octet-stream' ? contentType : mimeExt,
      size: bytes.length,
    },
    bytes,
  };
}

/** 落池目的地：本地模式给 poolDir（storeBlob），远程模式给 hub 坐标（uploadBlob） */
type BlobSink = { poolDir: string } | { dataDir: string; remote: string };

async function blobFromFile(target: string, name: string | undefined, sink: BlobSink): Promise<number> {
  const { entry, bytes } = entryFromFile(target, name);
  const failed = await sinkBytes(entry, bytes, sink);
  if (failed !== null) {
    console.error(`error: ${failed}`);
    return 1;
  }
  printEntry(entry);
  return 0;
}

async function blobFromUrl(url: string, name: string | undefined, sink: BlobSink): Promise<number> {
  const { entry, bytes } = await entryFromUrl(url, name);
  const failed = await sinkBytes(entry, bytes, sink);
  if (failed !== null) {
    console.error(`error: ${failed}`);
    return 1;
  }
  printEntry(entry);
  return 0;
}

/** 把字节落到池（本地）或 hub（远程）。返回 null=成功；字符串=失败原因（已定形，调用方打） */
async function sinkBytes(entry: BlobEntry, bytes: Buffer, sink: BlobSink): Promise<string | null> {
  if ('poolDir' in sink) {
    const stored = storeBlob(sink.poolDir, bytes);
    if (stored !== entry.hash) throw new Error('internal error: stored blob hash mismatch');
    console.log(`stored:  ${stored}  (in ${sink.poolDir})`);
    return null;
  }
  const err = await uploadBlob(sink.dataDir, sink.remote, entry.hash, bytes);
  if (err !== null) return err;
  console.log(`uploaded:  ${entry.hash}  (on the hub)`);
  return null;
}

function printEntry(entry: BlobEntry): void {
  console.log(JSON.stringify(entry, null, 2));
  console.log('\npaste this object into an action\'s "attachments", then reference it in content as ![caption](<name>)');
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
  csv: 'text/csv', zip: 'application/zip', gz: 'application/gzip',
  yaml: 'text/yaml', yml: 'text/yaml', wasm: 'application/wasm',
};

function mimeFromName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}
