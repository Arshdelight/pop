import { aggregateView, exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { renderSteps, viewHeader } from '../render.js';

export interface ShowOpts {
  dataDir?: string;
  hash: string;
  json: boolean;
  doc: boolean;
}

/** Inspect one node: aggregate view (default), --json for the StandardView, --doc for the document form */
export function runShow(opts: ShowOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  const hash = resolveNodeRef(ws, opts.hash);
  const node = ws.nodes.get(hash)!;

  if (opts.doc) {
    console.log(JSON.stringify(exportSubtree(node, ws.nodes), null, 2));
    return 0;
  }

  const view = aggregateView(hash, ws.nodes);
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return 0;
  }

  console.log(viewHeader(view));
  if (view.description !== undefined) console.log(`\ndescription: ${view.description}`);
  if (view.content !== undefined && view.content.trim() !== '') console.log(`\n${view.content}`);

  if (view.steps.length > 0) {
    console.log('\nsteps:');
    for (const line of renderSteps(view.steps, ws.nodes)) console.log(`  ${line}`);
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
