import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { storeBlob } from '@arshdelight/pop-sdk';
import { defaultDataDir } from '../state.js';
import { isInitialized } from '../workspace.js';

export interface BlobOpts {
  dataDir?: string;
  positional: string[];
  name?: string;
}

/**
 * Stage an attachment and emit the ready-to-paste attachment entry.
 * - Local file: hashed + stored into the workspace blob channel (when the data
 *   dir is initialized), entry emitted without url.
 * - http(s) URL: fetched once to compute the identity hash, entry emitted WITH
 *   the source url (bytes stay external, spec §5 — identity remains the hash).
 *
 * Attachments are immutable content: the emitted entry goes into the author's
 * document JSON (then `practi new`), never mutated onto an existing node.
 */
/** decodeURIComponent 的 URIError 兜底：a%zz 这类坏转义用原名 */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export async function runBlobAdd(opts: BlobOpts): Promise<number> {
  const target = opts.positional[0];
  if (!target) {
    console.error('usage: practi blob add <file-or-url> [--name <name>]');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  if (/^https?:\/\//i.test(target)) return blobFromUrl(target, opts.name);
  return blobFromFile(target, opts.name, dataDir);
}

function blobFromFile(target: string, name: string | undefined, dataDir: string): number {
  const bytes = fs.readFileSync(target);
  const base = path.basename(target);
  const hash = sha256(bytes);
  if (isInitialized(dataDir)) {
    const stored = storeBlob(dataDir, bytes);
    if (stored !== hash) throw new Error('internal error: stored blob hash mismatch');
    console.log(`stored:  ${stored}  (in ${dataDir})`);
  }
  printEntry({
    name: name ?? base,
    hash,
    mime: mimeFromName(base),
    size: bytes.length,
  });
  return 0;
}

const MAX_URL_BYTES = 25 * 1024 * 1024;

async function blobFromUrl(url: string, name: string | undefined): Promise<number> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const contentType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_URL_BYTES) {
    throw new Error(`file too large: ${declared} bytes (limit ${MAX_URL_BYTES})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_URL_BYTES) {
    throw new Error(`file too large: ${bytes.length} bytes (limit ${MAX_URL_BYTES})`);
  }
  let base = '';
  try {
    base = path.posix.basename(new URL(url).pathname);
  } catch {
    base = '';
  }
  const mimeExt = mimeFromName(base);
  printEntry({
    name: name ?? (base && base !== '/' ? safeDecode(base) : 'attachment'),
    hash: sha256(bytes),
    mime: contentType && contentType !== 'application/octet-stream' ? contentType : mimeExt,
    size: bytes.length,
    url,
  });
  return 0;
}

function printEntry(entry: Record<string, unknown>): void {
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
