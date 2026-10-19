import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import {
  checkoutTip,
  fetchInstanceChain,
  persistIfMoved,
  syncInstanceObjects,
} from '../sync.js';
import { shortHash } from '../render.js';

export interface CloneOpts {
  dataDir?: string;
  positional: string[];
}

/** `practi clone <owner>/<name>[@branch]` 的 ref 形态（分支段可选，缺省=实例默认支） */
export function parseCloneRef(ref: string): { owner: string; name: string; branch?: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)\/([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)(?:@([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?))?$/.exec(ref);
  if (!m) return null;
  const [, owner, name, branch] = m;
  return { owner, name, branch };
}

/**
 * practi clone <owner>/<name>[@branch]：把一个实践实例拉进工作区并绑定（git clone 同构）。
 * - 拉当前支全部版本的对象（历史=对象，不进 direct——git 同构：只有 HEAD 是 ref）
 * - 绑定写 practi.json 的 instance 字段（此后的 push/pull/log 都在「这个仓库」里）
 * - 检出支 tip 为 direct（工作区已有的其它 direct 原样保留，提示带 hash 操作）
 * 认领制退役（2026-10-19）：clone 的对象就是实践实例——没有脱离实例的「我的认领表」。
 */
export async function runClone(opts: CloneOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const ref = opts.positional[0];
  const parsed = ref ? parseCloneRef(ref) : null;
  if (!parsed) {
    console.error('usage: practi clone <owner>/<name>[@branch]');
    return 1;
  }
  const { owner, name, branch } = parsed;

  let view;
  try {
    view = await fetchInstanceChain(dataDir, state.remote.url, owner, name, branch);
  } catch (e) {
    console.error(`clone failed: ${(e as Error).message}`);
    return 1;
  }

  const ws = openWorkspace(dataDir);
  const sync = await syncInstanceObjects(dataDir, state.remote.url, view, (h) => ws.nodes.has(h));
  if (sync.failed.length > 0) {
    console.error(`clone incomplete: ${sync.failed.length} revision(s) failed to fetch`);
    return 1;
  }

  state.instance = { owner, name, branch: view.branch };
  const outcome = checkoutTip(state, view);
  saveState(dataDir, state);
  persistIfMoved(dataDir, state, outcome);

  console.log(`cloned:  ${owner}/${name} (${view.visibility}, branch ${view.branch}, ${view.revisions.length} revision(s))`);
  if (sync.missing > 0) {
    console.log(`note: ${sync.missing} revision(s) missing on the hub (history traces of hard-deleted documents)`);
  }
  switch (outcome.kind) {
    case 'up-to-date':
      console.log(`head:    ${shortHash(outcome.head)}  (already a direct pop)`);
      break;
    case 'fast-forward':
      console.log(`head:    ${shortHash(outcome.to)}  (fast-forwarded from ${shortHash(outcome.from)})`);
      break;
    case 'checked-out':
      console.log(`head:    ${outcome.head}`);
      if (state.direct.length > 1) {
        console.log(`note: ${state.direct.length - 1} other direct pop(s) remain — push/edit take an explicit hash when several are registered`);
      }
      break;
    case 'untouched':
      console.log(`head:    ${view.head ?? '(none)'}  (not checked out — ${outcome.reason})`);
      break;
  }
  return 0;
}
