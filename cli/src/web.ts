import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { aggregateView, computeNodeHash, exportSubtree, readBlob, resolveNodeRef, PracticeError } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from './state.js';
import { nodeFileTime, openWorkspace } from './workspace.js';
import { loadNotes, subtreeHashes, insertNote, updateNote, removeNote, NOTES_FILE } from './notes.js';
import { runNew } from './cmd/new.js';
import { runPull } from './cmd/pull.js';
import { runPush } from './cmd/push.js';
import { runLogin, runLogout, runMe } from './cmd/login.js';

export interface WebOpts {
  dataDir?: string;
  port: number;
  open: boolean;
}

/** 内置默认前端（随包分发的普通文件）：dist/../web-default 与 src/../web-default 都指向 cli/web-default */
const DEFAULT_WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web-default');

/** workspace 里的覆盖目录名：里面的文件按文件级覆盖默认前端（不存在的文件回落默认） */
const WEB_OVERRIDE_DIR = 'web';

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

/** live reload 客户端：连 SSE，收到 reload 整页刷新（只读页面无状态，整刷即热更）；
 *  收到 notes（笔记文件变更，服务器侧已不对其整刷）转发为 DOM 事件，详情页自行局部更新 */
const LR_SCRIPT = "(function(){var es=new EventSource('/_lr');es.addEventListener('reload',function(){location.reload()});es.addEventListener('notes',function(){document.dispatchEvent(new CustomEvent('practi:notes'))});})();";

function injectLiveReload(html: string): string {
  const tag = '<script src="/_lr.js" defer></script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag;
}

export function runWeb(opts: WebOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  // validate the data dir up front so a typo fails fast instead of on first request
  openWorkspace(dataDir);
  const url = `http://127.0.0.1:${opts.port}/`;

  // live reload：SSE 客户端池 + 文件/数据监听。监听面 = 整个 data dir（nodes/、
  // 覆盖目录 web/、practi.json 全覆盖：另一终端 practi new/pull 页面也会自动跟新）
  // + 内置默认前端目录（CLI 开发期改默认文件也即时生效）
  const clients = new Set<http.ServerResponse>();
  watchLive([dataDir, DEFAULT_WEB_DIR], clients);

  const overrideDir = path.join(dataDir, WEB_OVERRIDE_DIR);
  console.log(`frontend: ${fs.existsSync(overrideDir) ? `workspace override ${overrideDir} (missing files fall back to built-in)` : `built-in default (drop files into ${overrideDir}${path.sep} to customize)`}`);

  const server = http.createServer((req, res) => {
    try {
      // ws 每请求重建：命令写入（本端点的 /api/run，或另一终端的 practi new/pull）
      // 必须立即可见，不能拿启动时的快照过滤数据窗
      handle(req, res, dataDir, openWorkspace(dataDir), clients);
    } catch (e) {
      if (e instanceof PracticeError) {
        send(res, 404, 'text/plain; charset=utf-8', `${e.code}: ${e.message}`);
      } else {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(e instanceof Error ? e.message : String(e));
      }
    }
  });

  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`practi web: ${url}`);
    console.log(`data dir: ${dataDir}`);
    console.log('press Ctrl-C to stop');
    if (opts.open) openBrowser(url);
  });
  return 0;
}

function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dataDir: string,
  ws: ReturnType<typeof openWorkspace>,
  clients: Set<http.ServerResponse>,
): void {
  const pathname = (req.url ?? '/').split('?')[0];
  const state = loadState(dataDir);

  if (pathname === '/_lr') {
    sseHandshake(req, res, clients);
    return;
  }
  if (pathname === '/_lr.js') {
    send(res, 200, 'text/javascript; charset=utf-8', LR_SCRIPT);
    return;
  }
  if (pathname === '/api/directs') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify(directsPayload(dataDir, ws, state), null, 2));
    return;
  }
  if (pathname === '/api/notes') {
    if (req.method === 'POST') void handleNoteWrite(req, res, dataDir, ws);
    else notesRoute(req, res, dataDir, ws);
    return;
  }
  if (pathname === '/api/run') {
    void handleRun(req, res, dataDir);
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    if (serveStatic(res, 'index.html', dataDir)) return;
    send(res, 500, 'text/plain; charset=utf-8', 'built-in web frontend missing — reinstall the CLI');
    return;
  }
  const pop = pathname.match(/^\/pop\/(.+)$/);
  if (pop) {
    const hash = decodeURIComponent(pop[1]).replace(/\.json$/, '');
    const resolved = resolveNodeRef(ws, hash);
    if (pathname.endsWith('.json')) {
      const view = aggregateView(resolved, ws.nodes);
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(view, null, 2));
      return;
    }
    if (!serveStatic(res, 'detail.html', dataDir)) {
      send(res, 500, 'text/plain; charset=utf-8', 'built-in web frontend missing — reinstall the CLI');
    }
    return;
  }
  const blob = pathname.match(/^\/blobs\/(sha256:[0-9a-f]{64})$/);
  if (blob) {
    const bytes = readBlob(ws.root, blob[1]);
    if (bytes === null) {
      send(res, 404, 'text/plain; charset=utf-8', 'E_BLOB_MISSING: blob not present in this workspace');
      return;
    }
    sendBytes(res, mimeFor(ws, blob[1]), bytes);
    return;
  }
  const doc = pathname.match(/^\/doc\/(.+)$/);
  if (doc) {
    const hash = decodeURIComponent(doc[1]).replace(/\.json$/, '');
    const node = ws.nodes.get(resolveNodeRef(ws, hash));
    if (node) {
      // 加法演进：树字段仍在顶层（老前端照常读），nodeIndex 是新增兄弟键（新前端才消费）。
      // 前端文件热更可能跑在服务器 dist 前面、用户覆盖的 web/ 也可能落后 CLI 升级——
      // 数据窗任何改动都必须新旧两端互容，不能用信封换结构
      const tree = exportSubtree(node, ws.nodes);
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...tree, nodeIndex: buildNodeIndex(tree) }, null, 2));
      return;
    }
  }
  if (pathname === '/healthz') {
    send(res, 200, 'text/plain', 'ok');
    return;
  }
  // 静态资产兜底（style.css / app.js / 自定义前端文件）：放在最后，不与 /pop /blobs /doc 抢路由
  if (serveStatic(res, pathname.slice(1), dataDir)) return;
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

// ── POST /api/run：写动作端点（DIY 前端消费，官方 web-default 不用）──
// 复用 CLI 命令函数，白名单对齐 CLI 实际命令。刻意不含 edit（交互编辑器）、
// update（自更新会动自身进程）、migrate（动数据目录）；new 只收 json 文本
// 不收 file 路径——不给 web 进程任意路径读文件的能力。后续按需加法扩。

interface RunSpec {
  /** 校验 args 并执行；返回 CLI 退出码。参数不合法抛 ApiError(400) */
  run(args: Record<string, unknown>, dataDir: string): Promise<number> | number;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function asStr(v: unknown): string | undefined {
  if (v !== undefined && typeof v !== 'string') throw new ApiError(400, 'string argument expected');
  return v;
}

const RUNNABLE: Record<string, RunSpec> = {
  new: {
    run: (a, d) => {
      const json = asStr(a.json);
      if (!json || !json.trim()) throw new ApiError(400, 'new requires args.json (POP document text)');
      return runNew({ dataDir: d, json, positional: [] });
    },
  },
  pull: {
    run: (a, d) => runPull({ dataDir: d, positional: hashArg(a) }),
  },
  push: {
    run: (a, d) => runPush({ dataDir: d, positional: hashArg(a) }),
  },
  login: {
    // OAuth 授权流：web 进程内起 loopback 回调 + 开系统浏览器，请求挂起至授权完成
    run: (a, d) => runLogin({ dataDir: d, noOpen: a.noOpen === true }),
  },
  logout: { run: (_a, d) => runLogout({ dataDir: d }) },
  me: { run: (_a, d) => runMe({ dataDir: d }) },
};

function hashArg(a: Record<string, unknown>): string[] {
  const hash = asStr(a.hash);
  return hash ? [hash] : [];
}

/** 命令输出捕获：命令函数走 console.log/error，调用期间临时替换收集，finally 恢复。
 *  进程级替换在并发下有竞态 → runQueue 互斥，同一时刻只跑一条命令（写操作本就不应并发） */
let runQueue: Promise<unknown> = Promise.resolve();

function enqueueRun<T>(fn: () => Promise<T>): Promise<T> {
  const next = runQueue.then(fn, fn);
  runQueue = next.catch(() => {});
  return next;
}

async function captureConsole(fn: () => Promise<number> | number): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errBuf: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void errBuf.push(a.join(' '));
  try {
    return { code: await fn(), out: out.join('\n'), err: errBuf.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** 安全闸：浏览器跨站 POST 必带 Origin；Origin 的 host 必须等于请求的 Host 头
 *  （即 127.0.0.1:port 本身），否则 403——挡 CSRF 与 DNS rebinding */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse, dataDir: string): Promise<void> {
  const fail = (status: number, message: string) => send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }));
  try {
    if (req.method !== 'POST') throw new ApiError(405, 'POST only');
    if (!sameOrigin(req)) throw new ApiError(403, 'same-origin POST required (Origin header missing or foreign)');
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.startsWith('application/json')) throw new ApiError(415, 'content-type must be application/json');

    const body = await readBody(req, 2 * 1024 * 1024);
    let parsed: { cmd?: unknown; args?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiError(400, 'request body is not valid JSON');
    }
    const spec = typeof parsed.cmd === 'string' ? RUNNABLE[parsed.cmd] : undefined;
    if (!spec) throw new ApiError(400, `unknown cmd — runnable: ${Object.keys(RUNNABLE).join(', ')}`);
    const args = parsed.args ?? {};

    const result = await enqueueRun(() =>
      captureConsole(() => spec.run(args, dataDir)).catch(e => {
        // 参数校验错误透传为 4xx；命令自身的异常对齐 CLI 顶层语义（打印 + 退出码 1），
        // 命令失败是结果不是服务器错误，不该是 500
        if (e instanceof ApiError) throw e;
        return { code: 1, out: '', err: e instanceof Error ? e.message : String(e) };
      }),
    );
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify(result));
  } catch (e) {
    if (e instanceof ApiError) fail(e.status, e.message);
    else fail(500, e instanceof Error ? e.message : String(e));
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'request body too large'));
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
 *  反解成 #编号引用用。与 hub 的 node_index 物化列同一思路——内容寻址下哈希不在树里，
 *  引用靠旁路登记。根（空路径）不成节、无编号，不登记（from 指向根按未命中回落哈希）。 */
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

function send(res: http.ServerResponse, code: number, type: string, body: string): void {  res.writeHead(code, { 'content-type': type });
  res.end(body);
}

/** 静态文件：workspace 的 web/ 按文件覆盖，缺失文件回落内置默认。
 *  拒绝 `..` 段做路径遍历防护；HTML 响应注入 live reload 脚本（对默认与自定义前端一视同仁） */
function serveStatic(res: http.ServerResponse, rel: string, dataDir: string): boolean {
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0 || parts.includes('..')) return false;
  const file = [path.join(dataDir, WEB_OVERRIDE_DIR, ...parts), path.join(DEFAULT_WEB_DIR, ...parts)]
    .find(f => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) return false;
  const type = STATIC_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  if (type.startsWith('text/html')) {
    res.end(injectLiveReload(body.toString('utf8')));
  } else {
    res.end(body);
  }
  return true;
}

/** 目录数据窗：direct 列表的名称/描述/统计 + 数据目录路径（前端头部展示用）。
 *  claimedAt=声明值（state.claims 盖戳）；addedAt=生效值，未盖戳的老数据回落节点文件
 *  mtime（推测值，前端弱化显示）——声明与推测不混装一个字段 */
function directsPayload(dataDir: string, ws: ReturnType<typeof openWorkspace>, state: ReturnType<typeof loadState>): unknown {
  const docs = state.direct
    .filter(h => ws.nodes.has(h))
    .map(h => {
      const v = aggregateView(h, ws.nodes);
      const claimedAt = state.claims?.[h] ?? null;
      return {
        hash: v.hash,
        name: v.name,
        description: v.description,
        type: v.type,
        op: v.type === 'practice' ? v.op : null,
        steps: v.steps.length,
        // 全树节点数（含根，=详情页侧栏 countNodes 口径）；steps 保留给既有消费者（加法演进）
        nodes: subtreeHashes(ws, h).size,
        outputs: v.outputs.length,
        claimedAt,
        addedAt: claimedAt ?? nodeFileTime(dataDir, h),
      };
    });
    return { dataDir, docs };
}

/** POST /api/notes：note 的第二个写入门（官方前端侧栏编辑用；CLI practi note 仍是第一门）。
 *  本地个人数据，无审核诉求，但 CSRF 闸与 /api/run 同规格（sameOrigin + application/json）。
 *  body={op:'add',hash,content} | {op:'edit',id,content} | {op:'delete',id}。 */

async function handleNoteWrite(req: http.IncomingMessage, res: http.ServerResponse, dataDir: string, ws: ReturnType<typeof openWorkspace>): Promise<void> {
  const fail = (status: number, message: string) => send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }));
  try {
    if (req.method !== 'POST') throw new ApiError(405, 'POST only');
    if (!sameOrigin(req)) throw new ApiError(403, 'same-origin POST required (Origin header missing or foreign)');
    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.startsWith('application/json')) throw new ApiError(415, 'content-type must be application/json');
    const body = await readBody(req, 256 * 1024);
    let parsed: { op?: unknown; hash?: unknown; id?: unknown; content?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiError(400, 'request body is not valid JSON');
    }
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const okBody = (note: unknown) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ note }, null, 2));

    switch (parsed.op) {
      case 'add': {
        if (!content.trim()) throw new ApiError(400, 'content required');
        const ref = typeof parsed.hash === 'string' ? parsed.hash : '';
        let hash: string;
        try {
          hash = resolveNodeRef(ws, ref);
        } catch (e) {
          throw new ApiError(404, e instanceof PracticeError ? `${e.code}: ${e.message}` : String(e));
        }
        return void okBody(insertNote(dataDir, hash, content));
      }
      case 'edit': {
        if (!content.trim()) throw new ApiError(400, 'content required');
        const id = typeof parsed.id === 'string' ? parsed.id : '';
        const m = updateNote(dataDir, id, content);
        if (!m.ok) throw mutationError(id, m);
        return void okBody(m.note);
      }
      case 'delete': {
        const id = typeof parsed.id === 'string' ? parsed.id : '';
        const m = removeNote(dataDir, id);
        if (!m.ok) throw mutationError(id, m);
        return void send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ deleted: true, id: m.note.id }, null, 2));
      }
      default:
        throw new ApiError(400, 'op must be add | edit | delete');
    }
  } catch (e) {
    if (e instanceof ApiError) fail(e.status, e.message);
    else fail(500, e instanceof Error ? e.message : String(e));
  }
}

function mutationError(id: string, m: Exclude<ReturnType<typeof updateNote>, { ok: true }>): ApiError {
  return m.reason === 'not_found'
    ? new ApiError(404, `note "${id}" not found`)
    : new ApiError(400, `note id prefix "${id}" matches ${m.matches} notes`);
}

/** 笔记数据窗：GET /api/notes?ref=<hash> → 该节点子树内的本地笔记（存入顺序=时间正序）。
 *  独立只读端点、纯加法（不碰既有数据窗）；写入口在 CLI（practi note）。ref 缺失 400、
 *  解析不到 404——错误对齐其它路由的纯文本口径。notes.json 在 dataDir 下，live reload
 *  天然覆盖：另一终端 note add 后页面自动刷新出笔记 */
function notesRoute(req: http.IncomingMessage, res: http.ServerResponse, dataDir: string, ws: ReturnType<typeof openWorkspace>): void {
  const ref = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ref');
  if (!ref) {
    send(res, 400, 'text/plain; charset=utf-8', 'E_ARGS: missing ?ref=<hash>');
    return;
  }
  let hash: string;
  try {
    hash = resolveNodeRef(ws, ref);
  } catch (e) {
    const msg = e instanceof PracticeError ? `${e.code}: ${e.message}` : String(e);
    send(res, 404, 'text/plain; charset=utf-8', msg);
    return;
  }
  const set = subtreeHashes(ws, hash);
  const notes = loadNotes(dataDir).notes.filter(n => set.has(n.hash));
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ notes }, null, 2));
}

function sseHandshake(req: http.IncomingMessage, res: http.ServerResponse, clients: Set<http.ServerResponse>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

/** 监听 roots（递归；平台不支持时降级单层，再失败静默跳过——live reload 是锦上添花，不致命）。
 *  事件去抖：一次保存或一条 practi 命令会喷一串文件事件，合并成一次广播。
 *  notes.json 例外：不触发整页 reload（写字段的页面自己会局部更新，整刷会白屏闪烁），
 *  改发轻量 notes 事件——前端只重拉笔记数据重绘右栏，内容区/滚动位/草稿全程不动 */
function watchLive(roots: string[], clients: Set<http.ServerResponse>): void {
  let reloadTimer: NodeJS.Timeout | null = null;
  let notesTimer: NodeJS.Timeout | null = null;
  const broadcast = (event: 'reload' | 'notes') => {
    if (clients.size === 0) return;
    for (const res of clients) res.write(`event: ${event}\ndata: 1\n\n`);
  };
  const onChange = (_event: string, filename: string | null) => {
    const isNotes = filename !== null && path.basename(filename) === NOTES_FILE;
    const unknown = filename === null; // 个别平台不给文件名：保守起见两种事件都发——宁多推一次不漏
    if (!isNotes || unknown) {
      if (reloadTimer === null) {
        reloadTimer = setTimeout(() => { reloadTimer = null; broadcast('reload'); }, 150);
      }
    }
    if (isNotes || unknown) {
      if (notesTimer === null) {
        notesTimer = setTimeout(() => { notesTimer = null; broadcast('notes'); }, 150);
      }
    }
  };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      fs.watch(root, { recursive: true }, onChange);
    } catch {
      try {
        fs.watch(root, onChange);
      } catch {
        // fs.watch 完全不可用：live reload 静默失效，其余功能不受影响
      }
    }
  }
  // 保活注释行：防空闲 SSE 连接被掐（本地一般无此问题，防御性）
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000).unref();
}

function sendBytes(res: http.ServerResponse, type: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(body);
}

/** Best-effort mime for a local blob, looked up from any action that references it */
function mimeFor(ws: ReturnType<typeof openWorkspace>, hash: string): string {
  for (const n of ws.nodes.values()) {
    if (n.type !== 'action') continue;
    for (const a of n.attachments ?? []) {
      if (a.hash === hash && a.mime) return a.mime;
    }
  }
  return 'application/octet-stream';
}

export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    // cmd 把 & 当命令分隔符，URL 必须整体加引号（否则带 query 的 OAuth 授权 URL 被截断在首个 &）；
    // start 的首个引号参数是窗口标题占位；/d /s + verbatim 让 cmd 按原样解析这条命令行
    spawn('cmd', ['/d', '/s', '/c', `start "" "${url}"`], {
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      detached: true,
    }).unref();
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

