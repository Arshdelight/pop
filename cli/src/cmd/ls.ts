import { aggregateView, type StandardView } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { renderSteps, shortHash, viewHeader } from '../render.js';

export interface LsOpts {
  dataDir?: string;
  all: boolean;
  json: boolean;
}

export function runLs(opts: LsOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  const state = loadState(dataDir);

  // direct = registered roots (own uploads); indirect = every other node in the workspace
  const direct = state.direct.filter(h => ws.nodes.has(h));
  const directSet = new Set(state.direct);
  const indirect = [...ws.nodes.keys()].filter(h => !directSet.has(h));

  if (opts.json) {
    const views: StandardView[] = direct.map(h => aggregateView(h, ws.nodes));
    const indirectNodes = indirect.map(h => {
      const n = ws.nodes.get(h)!;
      return { hash: h, name: n.name, type: n.type, ...(n.type === 'practice' ? { op: n.op } : {}) };
    });
    console.log(JSON.stringify({ direct: views, indirect: indirectNodes }, null, 2));
    return 0;
  }

  if (direct.length === 0) {
    console.log('(no direct pops — create one with `practi new <file.json>` or `practi new --json \'{...}\'`)');
  }
  for (const h of direct) {
    const view = aggregateView(h, ws.nodes);
    console.log(viewHeader(view));
    for (const line of renderSteps(view.steps, ws.nodes)) console.log(`  ${line}`);
  }

  if (opts.all && indirect.length > 0) {
    console.log('\nINDIRECT (nodes referenced by direct pops, not registered as direct):');
    // which direct root references each indirect node
    const refsByNode = new Map<string, string[]>();
    for (const h of direct) {
      const stepRefs = new Set(aggregateView(h, ws.nodes).steps.map(s => s.refHash));
      for (const i of indirect) {
        if (stepRefs.has(i)) {
          const list = refsByNode.get(i) ?? [];
          list.push(ws.nodes.get(h)!.name);
          refsByNode.set(i, list);
        }
      }
    }
    for (const h of indirect) {
      const n = ws.nodes.get(h)!;
      const refs = refsByNode.get(h);
      const refText = refs ? `  (referenced by: ${refs.join(', ')})` : '';
      console.log(`  ${shortHash(h)}  ${n.name}  ${n.type === 'practice' ? `[practice·${n.op}]` : '[action]'}${refText}`);
    }
  }

  if (ws.parseIssues.length > 0) {
    console.error(`\nwarning: ${ws.parseIssues.length} parse issue(s) in the workspace`);
    for (const i of ws.parseIssues) console.error(`  ${i.code}: ${i.message}`);
  }
  return 0;
}
