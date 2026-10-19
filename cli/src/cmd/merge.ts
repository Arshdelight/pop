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

interface HubRevision {
  root_hash: string;
  parent_hash?: string | null;
}

/**
 * practi merge <branch>：把指定支合并进当前绑定的支（git merge 同构，合并方向=参数支 → 当前支）。
 * POP 2.0：血统边在 hub 提交链的 parent_hash 上（spec §9.1 仓库层历史），文档是纯快照，
 * 不再构造驮式合并修订。两种结局，按提交链现算可达性决定：
 * - fast-forward：参数支 tip 沿 parent 链可达当前支头 → 纯移指针（PUT head），零新提交；
 * - 分叉（squash）：不可达 → POST {document: 参数支 tip 的树, message: "merge branch X"}，
 *   服务端以当前支头为父追加一条 squash 提交并绑头。合并永远可完成；等价 git 的 squash merge。
 * 合并提交在 hub 上、本地还没有——提示 `practi pull <hash>` 同步。
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
      revisions?: HubRevision[];
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
  let parents: Map<string, string | null>;
  try {
    const into = await fetchBranch(intoBranch);
    const from = await fetchBranch(fromBranch);
    intoTip = into.branch_head_hash ?? null;
    fromTip = from.branch_head_hash ?? null;
    // 提交链现算可达性：两条支的登记提交合起来看（seq 是实例级登记，parent 才是血统边）
    parents = new Map([...(into.revisions ?? []), ...(from.revisions ?? [])].map((r) => [r.root_hash, r.parent_hash ?? null]));
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

  // 快进判定：from tip 沿 parent 链能走到 into tip（或 into 还没有任何提交）
  const reaches = (from: string, target: string | null): boolean => {
    if (target === null) return true;
    const seen = new Set<string>();
    let cur: string | null = from;
    while (cur !== null && !seen.has(cur)) {
      if (cur === target) return true;
      seen.add(cur);
      cur = parents.get(cur) ?? null;
    }
    return false;
  };

  if (reaches(fromTip, intoTip)) {
    const res = await authedFetch(dataDir, state.remote!.url, `${base}/branches/${encodeURIComponent(intoBranch)}/head`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_hash: fromTip }),
    });
    const body = await res.json();
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      console.error(`error: fast-forward failed — ${detail}`);
      return 1;
    }
    console.log(`fast-forward: ${intoBranch} → ${shortHash(fromTip)} (merged ${fromBranch})`);
    return 0;
  }

  // 分叉：squash 合并——内容=参数支 tip 的树，父=当前支头（服务端按头落库），说明=merge branch X
  if (!intoTip) {
    console.error('error: target branch diverged but has no head — cannot construct a merge commit');
    return 1;
  }
  const ws = openWorkspace(dataDir);
  const tipNode = ws.nodes.get(fromTip);
  if (!tipNode) {
    console.error(`error: branch tip ${shortHash(fromTip)} is not in the local workspace — \`practi pull ${shortHash(fromTip)}\` first`);
    return 1;
  }
  const doc = stripAttachmentUrls(exportSubtree(tipNode, ws.nodes));
  const stored = await authedFetch(dataDir, state.remote!.url, `${base}/branches/${encodeURIComponent(intoBranch)}/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, message: `merge branch '${fromBranch}'` }),
  });
  const storedBody = await stored.json();
  if (!stored.ok || typeof storedBody.root_hash !== 'string') {
    const detail = typeof storedBody.message === 'string' ? storedBody.message : `HTTP ${stored.status}`;
    console.error(`error: storing the merge commit failed — ${detail}`);
    return 1;
  }
  const mergeRoot = storedBody.root_hash;
  console.log(`merged (squash): ${fromBranch} → ${intoBranch} as ${shortHash(mergeRoot)}`);
  console.log(`note: the merge commit lives on the hub — \`practi pull ${shortHash(mergeRoot)}\` to sync it locally`);
  return 0;
}
