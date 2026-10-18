import { exportSubtree } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';
import { stripAttachmentUrls } from './push.js';

export interface MergeOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi merge <branch>：把指定支合并进当前绑定的支（git merge 同构，合并方向=参数支 → 当前支）。
 * POP 血统是单父链（revisions.from），两种结局：
 * - fast-forward：参数支 tip 是当前支头的直接后裔 → 纯移指针（服务端 FF 校验放行），零新文档；
 * - 分叉（squash）：当前支头也前进过 → 本地构造合并修订（内容=参数支 tip 的树，
 *   revisions 追加 {when, what: merge branch X, from: 当前支头}，合法 §2.2 语义）→
 *   存 hub → 绑当前支头。合并永远可完成；等价 git 的 squash merge。
 * 合并修订在 hub 上、本地还没有——提示 `practi pull <hash>` 同步。
 */
export async function runMerge(opts: MergeOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  if (!state.instance) {
    console.error('error: no instance bound — use `practi instance bind <owner>/<name>` first');
    return 1;
  }
  const fromBranch = opts.positional[0];
  if (!fromBranch) {
    console.error('usage: practi merge <branch>');
    return 1;
  }
  const { owner, name } = state.instance;
  const intoBranch = state.instance.branch;
  if (fromBranch === intoBranch) {
    console.error(`error: cannot merge ${fromBranch} into itself`);
    return 1;
  }
  const base = `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const fetchBranch = async (branch: string) => {
    const res = await authedFetch(dataDir, state.remote!.url, `${base}?branch=${encodeURIComponent(branch)}`);
    const body = (await res.json()) as unknown as {
      branch_head_hash?: string | null;
      revisions?: { root_hash: string }[];
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return body;
  };

  let intoTip: string | null;
  let fromTip: string | null;
  try {
    const into = await fetchBranch(intoBranch);
    const from = await fetchBranch(fromBranch);
    intoTip = into.branch_head_hash ?? null;
    fromTip = from.branch_head_hash ?? null;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
  if (!fromTip) {
    console.error(`error: branch ${fromBranch} has no revisions to merge`);
    return 1;
  }
  if (fromTip === intoTip) {
    console.log('already up to date');
    return 0;
  }

  const bind = async (hash: string): Promise<boolean> => {
    const res = await authedFetch(dataDir, state.remote!.url, `${base}/branches/${encodeURIComponent(intoBranch)}/head`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_hash: hash }),
    });
    const body = await res.json();
    if (res.ok) return true;
    if (body.code !== 'E_NOT_FAST_FORWARD') {
      const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
    }
    return false;
  };

  // 快进：from tip 是当前支头的直接后裔 → 纯移指针
  if (await bind(fromTip)) {
    console.log(`fast-forward: ${intoBranch} → ${shortHash(fromTip)} (merged ${fromBranch})`);
    return 0;
  }

  // 分叉：本地构造 squash 合并修订（内容=from tip 树 + revisions[from=intoTip]）
  if (!intoTip) {
    console.error('error: target branch diverged but has no head — cannot construct a merge revision');
    return 1;
  }
  const ws = openWorkspace(dataDir);
  const tipNode = ws.nodes.get(fromTip);
  if (!tipNode) {
    console.error(`error: branch tip ${shortHash(fromTip)} is not in the local workspace — \`practi pull ${shortHash(fromTip)}\` first`);
    return 1;
  }
  const doc = stripAttachmentUrls(exportSubtree(tipNode, ws.nodes)) as {
    revisions?: { when: string; what: string; from?: string }[];
  };
  doc.revisions = [
    ...(Array.isArray(doc.revisions) ? doc.revisions : []),
    { when: new Date().toISOString().slice(0, 10), what: `merge branch ${fromBranch}`, from: intoTip },
  ];
  // 合一端点：存合并修订 + 绑当前支头（from=intoTip，服务端 FF 必过）
  const stored = await authedFetch(dataDir, state.remote!.url, `${base}/branches/${encodeURIComponent(intoBranch)}/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc }),
  });
  const storedBody = await stored.json();
  if (!stored.ok || typeof storedBody.root_hash !== 'string') {
    const detail = typeof storedBody.message === 'string' ? storedBody.message : `HTTP ${stored.status}`;
    console.error(`error: storing the merge revision failed — ${detail}`);
    return 1;
  }
  const mergeRoot = storedBody.root_hash;
  console.log(`merged (squash): ${fromBranch} → ${intoBranch} as ${shortHash(mergeRoot)}`);
  console.log(`note: the merge revision lives on the hub — \`practi pull ${shortHash(mergeRoot)}\` to sync it locally`);
  return 0;
}
