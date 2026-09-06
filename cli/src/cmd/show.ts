import {
  PracticeError,
  aggregateView,
  exportSubtree,
  resolveNodeRef,
  type PNode,
} from '@arshdelight/pop-sdk';
import { defaultDataDir } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { renderSteps, viewHeader } from '../render.js';

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
 * 分开说话。 */
export function runShow(opts: ShowOpts): number {
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
      console.error(`error [E_NOT_FOUND]: node "${opts.hash}" is not in the local workspace (prefixes resolve only locally)`);
      return 1;
    }
    console.error(`error [E_NOT_FOUND]: node "${opts.hash}" is not in the local workspace`);
    return 1;
  }
  return renderNode(hash, ws.nodes, opts);
}

function renderNode(hash: string, nodes: Map<string, PNode>, opts: ShowOpts): number {
  const node = nodes.get(hash)!;

  if (opts.doc) {
    console.log(JSON.stringify(exportSubtree(node, nodes), null, 2));
    return 0;
  }

  // --json 传 full：机器视图带每步正文，AI 一次读全免逐哈希往返；人类文本仍走紧凑骨架
  const view = aggregateView(hash, nodes, opts.json ? { full: true } : undefined);
  // 读取宽容、出口报错：视图照常产出（丢的子树有占位条目），但缺失必须被看见——
  // 人类文本在尾部追加 E_MISSING 块，退出码 1；--json 由消费方读 view.missing 自行处置
  const code = view.missing !== undefined ? 1 : 0;
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return code;
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
  if (view.missing !== undefined && view.missing.length > 0) {
    console.error(`\nerror [E_MISSING]: ${view.missing.length} referenced node(s) absent from this workspace:`);
    for (const m of view.missing) {
      console.error(`  ${m.hash}  (referenced by "${m.parentName}" ${short(m.parentHash)})`);
    }
    console.error('  the view above shows placeholders where they belong — the node files are gone (or never synced here)');
  }
  return code;
}

function short(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 12);
}
