import fs from 'node:fs';
import { createFromDoc, loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';

export interface NewOpts {
  dataDir?: string;
  json?: string;
  file?: string;
  positional: string[];
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

/**
 * Create a pop from a JSON document: --json '<text>', <file.json>, or stdin
 * (all machine/AI friendly — no editor loop). Validates through the SDK,
 * persists the content-addressed tree, and registers the root as direct.
 */
export function runNew(opts: NewOpts): number {
  let text: string | undefined;
  if (opts.json !== undefined) text = opts.json;
  else if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.positional[0]) text = fs.readFileSync(opts.positional[0], 'utf8');
  else if (!process.stdin.isTTY) text = readStdin();

  if (text === undefined || text.trim() === '') {
    console.error('usage: pop new <file.json> | pop new --json \'<json text>\' | pop new < file.json');
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
  if (issues.length === 0 && !state.direct.includes(root)) {
    state.direct.push(root);
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
  }
  return 0;
}
