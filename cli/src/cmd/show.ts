import {
  PracticeError,
  aggregateView,
  exportSubtree,
  parseDocument,
  resolveNodeRef,
  type PNode,
} from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { renderSteps, viewHeader } from '../render.js';
import { authedFetch, requireCredentials } from '../client.js';

export interface ShowOpts {
  dataDir?: string;
  hash: string;
  json: boolean;
  doc: boolean;
}

/** Inspect one node: aggregate view (default), --json for the StandardView, --doc for the document form.
 *
 * 哈希纪律：本地索引本身即验证（loadWorkspace 重算每个节点，名实不符的 E_NODE_CORRUPT
 * 不进索引）——show 在「没找到」时先翻损坏记录，把「找到但哈希不正确」和「从未存在」
 * 分开说话；本地真没有则回落 hub（完整哈希；前缀只对本地工作区有意义），取回后
 * 重算根哈希三方比对（请求 ref ↔ hub 自称 ↔ 实算），不信传输也不信服务器自述。 */
export async function runShow(opts: ShowOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  let hash: string;
  try {
    hash = resolveNodeRef(ws, opts.hash);
  } catch (e) {
    if (!(e instanceof PracticeError) || e.code !== 'E_NOT_FOUND') throw e;
    const hex = opts.hash.replace(/^sha256:/i, '').toLowerCase();
    const corrupt = ws.parseIssues.find(
      (i) => i.code === 'E_NODE_CORRUPT' && i.file.endsWith(`${hex}.md`)
    );
    if (corrupt) {
      console.error(`error [E_NODE_CORRUPT]: the node file exists locally, but ${corrupt.message}`);
      if (corrupt.hint) console.error(`  hint: ${corrupt.hint}`);
      return 1;
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      console.error(`error [E_NOT_FOUND]: node "${opts.hash}" is not in the local workspace — the hub fallback needs the full hash (prefixes resolve only locally)`);
      return 1;
    }
    return remoteShow(opts, dataDir, `sha256:${hex}`);
  }
  return renderNode(hash, ws.nodes, opts);
}

/** hub 回落：公开文档匿名可读；带凭据走 authedFetch（可读自己的私有/待审）。
 *  取回后 parseDocument 重算根哈希——对不上就报「找到但哈希不正确」，绝不展示。 */
async function remoteShow(opts: ShowOpts, dataDir: string, ref: string): Promise<number> {
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const path = `/api/v1/pop/${encodeURIComponent(ref)}`;
  let res: Response;
  const authed = hasCredentials(dataDir);
  try {
    res = authed
      ? await authedFetch(dataDir, state.remote.url, path)
      : await fetch(`${state.remote.url}${path}`);
  } catch (e) {
    console.error(`error: hub unreachable — ${(e as Error).message}`);
    return 1;
  }
  const body = (await res.json().catch(() => ({}))) as {
    root_hash?: string; document?: unknown; code?: string; message?: string;
  };
  if (!res.ok) {
    if (res.status === 404) {
      console.error(`error [E_NOT_FOUND]: node "${ref}" is not in the local workspace and is not visible to you on ${state.remote.url}`);
    } else {
      console.error(`error: hub read failed — ${body.code ? `[${body.code}] ` : ''}${body.message ?? `HTTP ${res.status}`}`);
    }
    return 1;
  }

  let parsed: ReturnType<typeof parseDocument>;
  try {
    parsed = parseDocument(body.document);
  } catch (e) {
    console.error(`error [E_HASH_MISMATCH]: the hub returned something that does not parse as a document — ${(e as Error).message}`);
    return 1;
  }
  if (parsed.rootHash !== ref || parsed.rootHash !== body.root_hash) {
    const claimed = body.root_hash ?? '(none)';
    console.error(`error [E_HASH_MISMATCH]: found a document, but its content hashes to ${parsed.rootHash}, not the requested ${ref} (hub claims ${claimed}) — showing it would be showing unverified content`);
    return 1;
  }

  const nodes = new Map(parsed.nodeHashes);
  nodes.set(parsed.rootHash, parsed.root);
  if (!opts.json && !opts.doc) console.log(`from:     ${state.remote.url}  (hash verified)`);
  return renderNode(ref, nodes, opts);
}

function hasCredentials(dataDir: string): boolean {
  try {
    requireCredentials(dataDir);
    return true;
  } catch {
    return false;
  }
}

function renderNode(hash: string, nodes: Map<string, PNode>, opts: ShowOpts): number {
  const node = nodes.get(hash)!;

  if (opts.doc) {
    console.log(JSON.stringify(exportSubtree(node, nodes), null, 2));
    return 0;
  }

  // --json 传 full：机器视图带每步正文，AI 一次读全免逐哈希往返；人类文本仍走紧凑骨架
  const view = aggregateView(hash, nodes, opts.json ? { full: true } : undefined);
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return 0;
  }

  console.log(viewHeader(view));
  if (view.description !== undefined) console.log(`\ndescription: ${view.description}`);
  if (view.content !== undefined && view.content.trim() !== '') console.log(`\n${view.content}`);

  if (view.steps.length > 0) {
    console.log('\nsteps:');
    for (const line of renderSteps(view.steps, nodes)) console.log(`  ${line}`);
  }
  if (view.flow.length > 0) {
    console.log('\nflow:');
    for (const e of view.flow) {
      console.log(`  ${e.name}  ${short(e.fromHash)} (${e.fromName}) → ${short(e.toHash)} (${e.toName})`);
    }
  }
  if (view.inputs.length > 0) {
    console.log('\ndeclared inputs (needs):');
    for (const d of view.inputs) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.outputs.length > 0) {
    console.log('\ndeclared outputs (produces):');
    for (const d of view.outputs) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.attachments.length > 0) {
    console.log('\nattachments:');
    for (const a of view.attachments) console.log(`  ${a.name}  ${a.mime ?? ''}  ${a.size ?? ''}b  ${short(a.hash)}`);
  }
  if (view.revisions !== undefined && view.revisions.length > 0) {
    console.log('\nrevisions:');
    for (const r of view.revisions) console.log(`  ${r.when}  ${r.what}${r.from ? `  (from ${short(r.from)})` : ''}`);
  }
  return 0;
}

function short(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 12);
}
