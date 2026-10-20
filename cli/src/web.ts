import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { aggregateView, computeNodeHash, exportSubtree, readBlob, resolveNodeRef } from '@arshdelight/pop-sdk';
import { openPool, resolveRepo, type Repo } from './practice.js';
import { loadNotes, insertNote, updateNote, removeNote } from './notes.js';

export interface WebOpts {
  dir?: string;
  port: number;
  open: boolean;
}

/** 内置默认前端（随包分发的普通文件）：dist/../web-default 与 src/../web-default 都指向 cli/web-default */
const DEFAULT_WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web-default');

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function runWeb(opts: WebOpts): number {
  const repo = resolveRepo({ dir: opts.dir, verb: 'web' });
  if (repo === null) return 1;
  const url = `http://127.0.0.1:${opts.port}/`;

  const server = http.createServer((req, res) => {
    void handle(req, res, repo);
  });
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`practi web — ${repo.chain.name}@${repo.chain.current}  →  ${url}`);
    console.log('Ctrl+C to stop');
    if (opts.open) openBrowser(url);
  });
  return 0;
}

/** 打开系统默认浏览器（oauth 登录流程共用）；失败静默——URL 已打印在终端 */
export function openBrowser(url: string): void {
  const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(opener, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`open this in your browser: ${url}`));
    child.unref();
  } catch {
    console.log(`open this in your browser: ${url}`);
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, repo: Repo): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  try {
    if (pathname === '/api/repo') {
      const branch = new URL(req.url ?? '/', 'http://x').searchParams.get('branch') ?? repo.chain.current;
      const head = repo.chain.branches[branch] ?? null;
      const byRoot = new Map(repo.chain.commits.map((c) => [c.root, c]));
      const commits = [];
      const seen = new Set<string>();
      let cur = head;
      while (cur !== null && !seen.has(cur)) {
        const c = byRoot.get(cur);
        if (!c) break;
        seen.add(cur);
        commits.push({ seq: c.seq, root: c.root, message: c.message, pushedAt: c.pushedAt ?? null });
        cur = c.parent;
      }
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        name: repo.chain.name,
        owner: repo.chain.owner,
        current: repo.chain.current,
        branches: Object.entries(repo.chain.branches).map(([name, r]) => ({
          name,
          head: r,
          isDefault: name === 'main',
          current: name === repo.chain.current,
        })),
        branch,
        head,
        commits,
      }, null, 2));
      return;
    }
    if (pathname === '/api/notes') {
      if (req.method === 'POST') {
        await handleNoteWrite(req, res, repo.poolDir);
      } else {
        notesRoute(req, res, repo.poolDir);
      }
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(res, 'chain.html');
      return;
    }
    const pop = pathname.match(/^\/pop\/(.+)$/);
    if (pop) {
      const hash = pop[1].replace(/\.json$/, '');
      const ws = openPool(repo);
      const resolved = resolveNodeRef(ws, hash);
      if (pathname.endsWith('.json')) {
        const view = aggregateView(resolved, ws.nodes, { full: true });
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(view, null, 2));
        return;
      }
      serveStatic(res, 'detail.html');
      return;
    }
    const doc = pathname.match(/^\/doc\/(.+)$/);
    if (doc) {
      const hash = doc[1].replace(/\.json$/, '');
      const ws = openPool(repo);
      const node = ws.nodes.get(resolveNodeRef(ws, hash));
      if (!node) {
        send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'node not found' }));
        return;
      }
      const document = exportSubtree(node, ws.nodes) as Record<string, unknown>;
      // 加法演进：树字段在顶层（老前端照常读），nodeIndex 是新增兄弟键（前端把
      // inputs.from 反解成 #编号引用用——哈希不在树里，引用靠旁路登记）
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...document, nodeIndex: buildNodeIndex(document) }, null, 2));
      return;
    }
    const blob = pathname.match(/^\/blobs\/(sha256:[0-9a-f]{64})$/);
    if (blob) {
      const ws = openPool(repo);
      const bytes = readBlob(ws.root, blob[1]);
      if (bytes === null) {
        send(res, 404, 'text/plain; charset=utf-8', 'E_BLOB_MISSING: blob not present in this practice');
        return;
      }
      sendBytes(res, mimeFor(bytes), bytes);
      return;
    }
    if (serveStatic(res, pathname.slice(1))) return;
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain; charset=utf-8', e instanceof Error ? e.message : String(e));
  }
}

// ── 学习笔记（/api/notes，sidecar .practi/notes.json；GET 按哈希分组、?ref= 过滤；POST add/update/delete）──

function notesRoute(req: http.IncomingMessage, res: http.ServerResponse, poolDir: string): void {
  const ref = new URL(req.url ?? '/', 'http://x').searchParams.get('ref') ?? undefined;
  const byHash: Record<string, unknown[]> = {};
  for (const n of loadNotes(poolDir).notes) {
    if (ref !== undefined && n.hash !== ref) continue;
    (byHash[n.hash] ??= []).push(n);
  }
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(byHash, null, 2));
}

async function handleNoteWrite(req: http.IncomingMessage, res: http.ServerResponse, poolDir: string): Promise<void> {
  const fail = (status: number, message: string) => send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }));
  try {
    if (req.method !== 'POST') throw new Error('POST only');
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string' || new URL(origin).host !== host) {
      throw new Error('same-origin POST required');
    }
    const body = JSON.parse(await readBody(req, 1024 * 1024)) as { op?: unknown; id?: unknown; hash?: unknown; text?: unknown };
    // 口径与 CLI 对齐：文本非空（trim 后），update/delete 的未知 id/歧义前缀如实 400
    const fail = (m: string) => { throw new Error(m); };
    if (body.op === 'add' && typeof body.hash === 'string' && typeof body.text === 'string' && body.text.trim() !== '') {
      insertNote(poolDir, body.hash, body.text);
    } else if (body.op === 'update' && typeof body.id === 'string' && typeof body.text === 'string' && body.text.trim() !== '') {
      const m = updateNote(poolDir, body.id, body.text);
      if (!m.ok) fail(m.reason === 'ambiguous' ? `ambiguous note id: ${body.id}` : 'no such note');
    } else if (body.op === 'delete' && typeof body.id === 'string') {
      const m = removeNote(poolDir, body.id);
      if (!m.ok) fail(m.reason === 'ambiguous' ? `ambiguous note id: ${body.id}` : 'no such note');
    } else {
      throw new Error('op must be add{hash,text} / update{id,text} / delete{id} (text must be non-empty)');
    }
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
  } catch (e) {
    fail(400, e instanceof Error ? e.message : String(e));
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 节点指纹登记簿（哈希→树内 children 下标路径），/doc 数据窗附带：前端把 inputs.from
 *  反解成 #编号引用用。根（空路径）不成节、无编号，不登记。 */
function buildNodeIndex(tree: Record<string, unknown>): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  type Hashable = Parameters<typeof computeNodeHash>[0];
  const visit = (n: Record<string, unknown>, p: number[]): void => {
    if (p.length > 0) index[computeNodeHash(n as Hashable)] = p;
    const kids = Array.isArray(n.children) ? (n.children as Record<string, unknown>[]) : [];
    kids.forEach((c, i) => visit(c, [...p, i]));
  };
  visit(tree, []);
  return index;
}

function serveStatic(res: http.ServerResponse, rel: string): boolean {
  const file = path.join(DEFAULT_WEB_DIR, rel);
  if (!file.startsWith(DEFAULT_WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream';
  sendBytes(res, type, fs.readFileSync(file));
  return true;
}

function mimeFor(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '<?xml') return 'image/svg+xml';
  return 'application/octet-stream';
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}

function sendBytes(res: http.ServerResponse, type: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}
