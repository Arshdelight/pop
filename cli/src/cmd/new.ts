import fs from 'node:fs';
import { createFromDoc, loadWorkspace, validateWorkspace, type Workspace } from '@arshdelight/pop-sdk';
import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace, subtreeFiles } from '../workspace.js';
import { printQualityHints } from '../quality.js';
import { nodeIndexFields } from '../retrieval.js';
import { describeRefresh, refreshVectors } from '../embed/optional.js';

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
  // 门禁只统计本次子树：其它文档的历史问题不连坐本次注册（v1.1.0 前的外链引用/
  // 缺字节旧附件只在其自身被 new/edit 时才拦）
  const loaded = loadWorkspace(dataDir);
  const mine = subtreeFiles(loaded, root);
  const issues = validateWorkspace(loaded).filter((i) => mine.has(i.file));

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
    return 1; // 存了但没注册成=没办成正事，与 edit 同类失败对齐
  }
  console.log('status:   valid, registered as direct');
  // W_* 提示：登记已完成，提示只影响写作，不影响结果（E_ 在上面已经拦掉了）
  printQualityHints(loaded, root);
  // 向量索引保鲜：只在**已经启用**（pull 过模型且 build 过）时顺手补几个新节点；
  // 没启用就一次网络/原生调用都不发生（见 embed/optional.ts）
  const note = describeRefresh(await refreshVectors(dataDir, [...loaded.nodes.keys()].sort(), (h) => indexTextOf(h, loaded)));
  if (note !== null) console.error(note);
  return 0;
}

/** 与 search 同一口径的索引文本（全字段拼接） */
function indexTextOf(hash: string, ws: Workspace): string {
  const e = nodeIndexFields(hash, ws.nodes.get(hash)!);
  return Object.values(e.fields).filter((v): v is string => typeof v === 'string').join('\n');
}
