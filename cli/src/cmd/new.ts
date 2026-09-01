import fs from 'node:fs';
import { createFromDoc, loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { runPublish } from './lifecycle.js';
import { storeDocumentRemote } from '../client.js';

export interface NewOpts {
  dataDir?: string;
  json?: string;
  file?: string;
  remote?: boolean;
  publish?: boolean;
  positional: string[];
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

/**
 * Create a POP from a JSON document: --json '<text>', <file.json>, or stdin
 * (all machine/AI friendly — no editor loop). Validates through the SDK,
 * persists the content-addressed tree, and registers the root as direct.
 *
 * --remote switches the whole creation to the hub: the authoring JSON goes to
 * the existing POST /api/v1/pop (the hub runs the same SDK parse + hashing),
 * nothing is written locally. --publish additionally submits for review and
 * requires --remote (publishing needs the document on the hub first).
 */
export async function runNew(opts: NewOpts): Promise<number> {
  // 旗标组合的语义错误先于 IO 报（missing.json --publish 应报 --publish requires --remote 而非 ENOENT）
  if (opts.publish === true && opts.remote !== true) {
    console.error('error: --publish requires --remote — publishing needs the document on the hub first');
    return 1;
  }

  let text: string | undefined;
  if (opts.json !== undefined) text = opts.json;
  else if (opts.file) text = fs.readFileSync(opts.file, 'utf8');
  else if (opts.positional[0]) text = fs.readFileSync(opts.positional[0], 'utf8');
  else if (!process.stdin.isTTY) text = readStdin();

  if (text === undefined || text.trim() === '') {
    console.error('usage: practi new <file.json> | practi new --json \'<json text>\' | practi new < file.json');
    console.error('       [--remote (create on the hub only)] [--publish (submit for review; requires --remote)]');
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
  if (opts.remote === true) return remoteNew(opts, dataDir, doc);
  return localNew(dataDir, doc);
}

/** 本地默认路：SDK 校验 → 内容寻址落盘 → 注册 direct。 */
function localNew(dataDir: string, doc: unknown): number {
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
    return 1; // 存了但没注册成=没办成正事，与 edit 同类失败及 --remote 的服务端 422 对齐
  }
  console.log('status:   valid, registered as direct');
  return 0;
}

/** --remote：只有远端——创作 JSON 直送现有 POST /api/v1/pop（hub 委托官方 SDK 解析、
 *  规范化、算 root_hash 并认领，默认 PRIVATE），本地零写入，root 由服务端告知。
 *  注意：远端独占的文档下一次 practi pull 会拉回本地（它就是 hub 上你的认领），
 *  本地 ls/show/web/note 也看不见它。--publish 再链 submit 送审。 */
async function remoteNew(opts: NewOpts, dataDir: string, doc: unknown): Promise<number> {
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  let stored: Awaited<ReturnType<typeof storeDocumentRemote>>;
  try {
    stored = await storeDocumentRemote(dataDir, state.remote.url, doc);
  } catch (e) {
    console.error(`error: remote create failed — ${(e as Error).message}`);
    return 1;
  }
  console.log(`created:  ${stored.rootHash}  (on the hub — it parsed and hashed the tree; nothing written locally)`);
  console.log(`status:   ${stored.status}, claimed${stored.idempotent ? ' (already existed)' : ''}`);

  if (opts.publish === true) {
    const code = await runPublish({ dataDir, positional: [stored.rootHash] });
    if (code !== 0) {
      console.error('publish:  submit failed — the document is created on the hub (PRIVATE); run `practi publish <hash>` after fixing');
      return 1;
    }
  }
  return 0;
}
