import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { aggregateView, computeNodeHash, exportSubtree, readBlob, resolveNodeRef, PracticeError } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from './state.js';
import { nodeFileTime, openWorkspace } from './workspace.js';

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

/** live reload 客户端：连 SSE、收到 reload 事件整页刷新（只读浏览器无状态，整刷即热更） */
const LR_SCRIPT = "(function(){var es=new EventSource('/_lr');es.addEventListener('reload',function(){location.reload()});})();";

function injectLiveReload(html: string): string {
  const tag = '<script src="/_lr.js" defer></script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : html + tag;
}

export function runWeb(opts: WebOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  // validate the data dir up front so a typo fails fast instead of on first request
  const ws = openWorkspace(dataDir);
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
      handle(req, res, dataDir, ws, clients);
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
        outputs: v.outputs.length,
        claimedAt,
        addedAt: claimedAt ?? nodeFileTime(dataDir, h),
      };
    });
    return { dataDir, docs };
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
 *  事件去抖：一次保存或一条 practi 命令会喷一串文件事件，合并成一次 reload */
function watchLive(roots: string[], clients: Set<http.ServerResponse>): void {
  let timer: NodeJS.Timeout | null = null;
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (clients.size === 0) return;
      for (const res of clients) res.write('event: reload\ndata: 1\n\n');
    }, 150);
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

