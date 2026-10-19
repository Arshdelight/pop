import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import {
  checkoutTip,
  fetchInstanceChain,
  persistIfMoved,
  syncInstanceObjects,
} from '../sync.js';
import { shortHash } from '../render.js';

export interface PullOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi pull：把绑定实例当前支的远端更新拉进工作区（git pull 同构——认领制退役后
 * pull 的对象就是仓库/实例，2026-10-19 用户拍板「pull 也在仓库里 pull」）：
 * - 链上本地缺失的版本逐个拉取入库（历史=对象，验算过闸同 clone/fetch）
 * - 支 tip 落 direct：已在=up to date；恰一者在链上=fast-forward（换根）；
 *   本地头不在链上=检出 tip（未推送的本地改动保留，push 时按 hub 规则追加提交）。
 * 未绑实例 → 指引 clone / instance bind。
 */
export async function runPull(opts: PullOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  if (!state.instance) {
    console.error('error: no instance bound — pull works inside a practice instance (the hub has no claim table anymore)');
    console.error('       run `practi clone <owner>/<name>` or `practi instance bind <owner>/<name>` first');
    return 1;
  }
  const { owner, name, branch } = state.instance;
  if (opts.positional[0]) {
    console.error('error: pull takes no <hash> — it syncs the bound instance (use `practi fetch <hash>` for a single POP)');
    return 1;
  }

  let view;
  try {
    view = await fetchInstanceChain(dataDir, state.remote.url, owner, name, branch);
  } catch (e) {
    console.error(`pull failed: ${(e as Error).message}`);
    return 1;
  }

  const ws = openWorkspace(dataDir);
  const sync = await syncInstanceObjects(dataDir, state.remote.url, view, (h) => ws.nodes.has(h));

  const next = loadState(dataDir);
  const outcome = checkoutTip(next, view);
  persistIfMoved(dataDir, next, outcome);

  if (sync.failed.length > 0) {
    console.error(`pull incomplete: ${sync.failed.length} revision(s) failed to fetch`);
    return 1;
  }
  if (sync.fetched === 0 && outcome.kind === 'up-to-date') {
    console.log('up to date — nothing new to pull');
    return 0;
  }
  console.log(`pulled:  ${sync.fetched} revision(s) into ${owner}/${name}@${view.branch}`);
  if (sync.missing > 0) {
    console.log(`note: ${sync.missing} revision(s) missing on the hub (history traces of hard-deleted documents)`);
  }
  switch (outcome.kind) {
    case 'up-to-date':
      console.log(`head:    ${shortHash(outcome.head)}  (unchanged)`);
      break;
    case 'fast-forward':
      console.log(`head:    ${shortHash(outcome.to)}  (fast-forwarded from ${shortHash(outcome.from)})`);
      break;
    case 'checked-out':
      console.log(`head:    ${outcome.head}  (checked out${next.direct.length > 1 ? `; ${next.direct.length - 1} other direct pop(s) remain` : ''})`);
      break;
    case 'untouched':
      console.log(`head:    ${view.head ?? '(none)'}  (not moved — ${outcome.reason})`);
      break;
  }
  return 0;
}
