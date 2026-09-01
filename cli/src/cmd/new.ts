import fs from 'node:fs';
import { createFromDoc, loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { runPush } from './push.js';

export interface NewOpts {
  dataDir?: string;
  json?: string;
  file?: string;
  remote?: boolean;
  positional: string[];
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

/**
 * Create a POP from a JSON document: --json '<text>', <file.json>, or stdin
 * (all machine/AI friendly — no editor loop). Validates through the SDK,
 * persists the content-addressed tree, and registers the root as direct.
 */
export async function runNew(opts: NewOpts): Promise<number> {
  let text: string | undefined;
  if (opts.json !== undefined) text = opts.json;
  else if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.positional[0]) text = fs.readFileSync(opts.positional[0], 'utf8');
  else if (!process.stdin.isTTY) text = readStdin();

  if (text === undefined || text.trim() === '') {
    console.error('usage: practi new <file.json> | practi new --json \'<json text>\' | practi new < file.json');
    return 1;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`error [E_JSON]: not valid JSON — ${(e as Error).message}`);
    return 1;
  }

  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);
  const { root, count } = createFromDoc(ws, doc);
  const issues = validateWorkspace(loadWorkspace(dataDir));

  const state = loadState(dataDir);
  if (issues.length === 0 && claimDirect(state, root)) {
    saveState(dataDir, state);
  }

  console.log(`created:  ${root}`);
  console.log(`nodes:    ${count}`);
  if (issues.length > 0) {
    for (const i of issues) {
      console.error(`  ${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
    }
    console.error(`warning:  stored but NOT registered as direct — ${issues.length} validation issue(s)`);
  } else {
    console.log('status:   valid, registered as direct');
    // --remote：创建后顺手把这条认领推上 hub（ PRIVATE，不是公开——先记录后发布的边界不动）。
    // 推送失败不回滚（内容寻址，本地已是有效产物）：明说现状并留 push 自愈口。
    if (opts.remote === true) {
      const code = await runPush({ dataDir, positional: [root] });
      if (code !== 0) {
        console.error('remote:   push failed — the doc is created and registered locally; fix the above and run `practi push`');
        return 1;
      }
    }
  }
  return 0;
}
