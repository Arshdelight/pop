import http from 'node:http';
import { spawn } from 'node:child_process';
import { aggregateView, exportSubtree, readBlob, resolveNodeRef, PracticeError, type PNode, type StandardView } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from './state.js';
import { openWorkspace } from './workspace.js';
import { nodeTag, shortHash } from './render.js';

export interface WebOpts {
  dataDir?: string;
  port: number;
  open: boolean;
}

export function runWeb(opts: WebOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  // validate the data dir up front so a typo fails fast instead of on first request
  const ws = openWorkspace(dataDir);
  const url = `http://127.0.0.1:${opts.port}/`;

  const server = http.createServer((req, res) => {
    try {
      handle(req, res, dataDir, ws);
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
    console.log(`pop web: ${url}`);
    console.log(`data dir: ${dataDir}`);
    console.log('press Ctrl-C to stop');
    if (opts.open) openBrowser(url);
  });
  return 0;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, dataDir: string, ws: ReturnType<typeof openWorkspace>): void {
  const pathname = (req.url ?? '/').split('?')[0];
  const state = loadState(dataDir);

  if (pathname === '/' || pathname === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', indexHtml(ws, state.direct));
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
    const view = aggregateView(resolved, ws.nodes, { full: true });
    send(res, 200, 'text/html; charset=utf-8', detailHtml(ws, view));
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
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(exportSubtree(node, ws.nodes), null, 2));
      return;
    }
  }
  if (pathname === '/healthz') {
    send(res, 200, 'text/plain', 'ok');
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
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
  let args: string[];
  if (process.platform === 'win32') args = ['/c', 'start', '', url];
  else if (process.platform === 'darwin') args = [url];
  else args = [url];
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; color: #1a1a1a; background: #fafafa; }
  header { background: #111; color: #fff; padding: 14px 24px; display: flex; gap: 16px; align-items: baseline; }
  header .brand { font-weight: 700; letter-spacing: .5px; }
  header .sub { color: #999; font-size: 13px; }
  main { max-width: 860px; margin: 24px auto; padding: 0 24px 60px; }
  a { color: #0b57d0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px; }
  .card .title { font-weight: 600; font-size: 16px; }
  .tag { font-size: 12px; color: #666; background: #f0f0f0; border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
  .hash { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: #888; }
  pre { background: #fff; border: 1px solid #e3e3e3; border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; }
  th { color: #666; font-weight: 600; }
  .muted { color: #888; }
  .breadcrumb { margin-bottom: 12px; font-size: 13px; }
  .section { margin-top: 22px; }
  .section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .4px; color: #666; margin: 0 0 8px; }
  .step { padding: 2px 0; }
  .step .n { color: #999; }
  .stepbody { margin: 6px 0 12px 0; padding-left: 20px; }
  .prose { font-size: 14px; color: #333; }
  .prose figure { margin: 10px 0; }
  .prose img { max-width: 100%; border: 1px solid #e3e3e3; border-radius: 6px; }
  .prose figcaption { font-size: 12px; color: #888; text-align: center; margin-top: 4px; }
`;

function page(title: string, body: string, dataDir: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style></head><body>
<header><span class="brand">POP</span><span class="sub">local registry</span><span class="sub">${dataDir}</span></header>
<main>${body}</main></body></html>`;
}

function indexHtml(ws: ReturnType<typeof openWorkspace>, direct: string[]): string {
  const roots = direct.filter(h => ws.nodes.has(h));
  const cards = roots
    .map(h => {
      const view = aggregateView(h, ws.nodes);
      return `<div class="card">
        <div class="title"><a href="/pop/${encodeURIComponent(h)}">${escapeHtml(view.name)}</a><span class="tag">${view.type === 'practice' ? `practice·${view.op}` : 'action'}</span></div>
        <div class="hash">${view.hash}</div>
        ${view.description ? `<div class="muted">${escapeHtml(view.description)}</div>` : ''}
        <div class="muted">${view.steps.length} step${view.steps.length === 1 ? '' : 's'} · ${view.flow.length} flow edge${view.flow.length === 1 ? '' : 's'} · ${view.outputs.length} output${view.outputs.length === 1 ? '' : 's'}</div>
      </div>`;
    })
    .join('\n');
  const empty = roots.length === 0 ? '<p class="muted">no direct pops — create one with <code>pop new</code></p>' : '';
  return page('POP — local registry', `<h1>Direct pops</h1>${empty}${cards}`, ws.root);
}

function detailHtml(ws: ReturnType<typeof openWorkspace>, view: StandardView): string {
  const esc = escapeHtml;
  const steps = view.steps
    .map(s => {
      const n: PNode | undefined = ws.nodes.get(s.refHash);
      const tag = n ? nodeTag(n) : '';
      const body = s.content && s.content.trim() ? `<div class="stepbody">${renderContent(s.content, n, ws)}</div>` : '';
      return `<div class="step"><span class="n">${'&nbsp;&nbsp;'.repeat(s.depth)}</span>${esc(s.name)} ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}${s.note ? ` <span class="muted">(${esc(s.note)})</span>` : ''}${body}</div>`;
    })
    .join('\n');
  const flowRows = view.flow
    .map(e => `<tr><td>${esc(e.name)}</td><td class="hash">${shortHash(e.fromHash)}</td><td>${esc(e.fromName)}</td><td class="hash">${shortHash(e.toHash)}</td><td>${esc(e.toName)}</td></tr>`)
    .join('\n');
  const inputs = view.inputs.map(d => `<tr><td>${esc(d.name)}</td><td>${d.spec ? esc(d.spec) : ''}</td><td class="hash">${shortHash(d.refHash)}</td></tr>`).join('\n');
  const outputs = view.outputs.map(d => `<tr><td>${esc(d.name)}</td><td>${d.spec ? esc(d.spec) : ''}</td><td class="hash">${shortHash(d.refHash)}</td></tr>`).join('\n');
  const atts = view.attachments.map(a => `<tr><td>${esc(a.name)}</td><td>${a.mime ? esc(a.mime) : ''}</td><td>${a.size ?? ''}</td><td class="hash">${shortHash(a.hash)}</td></tr>`).join('\n');
  const revs = (view.revisions ?? []).map(r => `<tr><td>${esc(r.when)}</td><td>${esc(r.what)}</td>${r.from ? `<td class="hash">${shortHash(r.from)}</td>` : '<td></td>'}</tr>`).join('\n');

  return page(`${view.name} — POP`, `
    <div class="breadcrumb"><a href="/">← all pops</a></div>
    <h1>${esc(view.name)} <span class="tag">${view.type === 'practice' ? `practice·${view.op}` : 'action'}</span></h1>
    <div class="hash">${view.hash}</div>
    ${view.description ? `<p>${esc(view.description)}</p>` : ''}
    ${view.content && view.content.trim() ? `<div class="section"><h2>Content</h2>${renderContent(view.content, ws.nodes.get(view.hash), ws)}</div>` : ''}
    <div class="section"><h2>Steps (${view.steps.length})</h2>${steps || '<p class="muted">—</p>'}</div>
    ${flowRows ? `<div class="section"><h2>Flow (${view.flow.length})</h2><table><tr><th>name</th><th>from</th><th></th><th>to</th><th></th></tr>${flowRows}</table></div>` : ''}
    ${inputs ? `<div class="section"><h2>Declared inputs (needs)</h2><table><tr><th>name</th><th>spec</th><th>node</th></tr>${inputs}</table></div>` : ''}
    ${outputs ? `<div class="section"><h2>Declared outputs (produces)</h2><table><tr><th>name</th><th>spec</th><th>node</th></tr>${outputs}</table></div>` : ''}
    ${atts ? `<div class="section"><h2>Attachments</h2><table><tr><th>name</th><th>mime</th><th>size</th><th>hash</th></tr>${atts}</table></div>` : ''}
    ${revs ? `<div class="section"><h2>Revisions</h2><table><tr><th>when</th><th>what</th><th>from</th></tr>${revs}</table></div>` : ''}
    <div class="section"><h2>Links</h2>
      <a href="/pop/${encodeURIComponent(view.hash)}.json">StandardView JSON</a> ·
      <a href="/doc/${encodeURIComponent(view.hash)}.json">document JSON</a>
    </div>
  `, ws.root);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Render action content for the web UI: markdown image refs `![caption](name)`
 * become real <figure><img> (name → attachment url or a local /blobs/:hash);
 * http(s) URL targets are used as-is (external refs, spec §5.1); unresolved
 * refs stay literal. Fenced code blocks are treated as prose-exempt (§5.1).
 */
function renderContent(content: string, node: PNode | undefined, ws: ReturnType<typeof openWorkspace>): string {
  const blocks: string[] = [];
  const prose = content.replace(/```[\s\S]*?```/g, m => {
    blocks.push(m);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  const parts: string[] = [];
  let last = 0;
  for (const m of prose.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
    parts.push(escapeHtml(prose.slice(last, m.index)));
    const caption = m[1];
    const target = m[2];
    const url = mediaUrl(target, node, ws);
    if (url === null) {
      parts.push(escapeHtml(m[0]));
    } else {
      const cap = escapeHtml(caption);
      parts.push(`<figure><img src="${escapeHtml(url)}" alt="${cap}"><figcaption>${cap}</figcaption></figure>`);
    }
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(prose.slice(last)));
  return `<div class="prose">${parts.join('').replace(/\u0000B(\d+)\u0000/g, (_, i) => `<pre>${escapeHtml(blocks[Number(i)])}</pre>`)}</div>`;
}

function mediaUrl(target: string, node: PNode | undefined, ws: ReturnType<typeof openWorkspace>): string | null {
  if (/^https?:\/\//i.test(target)) return target;
  if (!node || node.type !== 'action') return null;
  const a = (node.attachments ?? []).find(x => x.name === target);
  return a ? (a.url ?? `/blobs/${a.hash}`) : null;
}
