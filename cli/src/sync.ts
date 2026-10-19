import { claimDirect, saveState, type State } from './state.js';
import { authedFetch, fetchRemoteDoc } from './client.js';

/** 实例在 hub 侧的链上视图（GET /api/v1/instances/{o}/{n}?branch= 的 CLI 侧子集） */
export interface InstanceChainView {
  name: string;
  visibility: string;
  branch: string;
  /** 当前支 tip（null=尚无版本） */
  head: string | null;
  /** 当前支历史（tip 在前）；missing=文档行已被硬删（历史痕迹仍可列） */
  revisions: { seq: number; root_hash: string; missing: boolean }[];
}

/** GET 实例链视图（clone/pull/switch/instance show 共用的口径） */
export async function fetchInstanceChain(
  dataDir: string,
  remote: string,
  owner: string,
  name: string,
  branch?: string
): Promise<InstanceChainView> {
  const q = branch !== undefined ? `?branch=${encodeURIComponent(branch)}` : '';
  const res = await authedFetch(
    dataDir,
    remote,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${q}`
  );
  const body = (await res.json().catch(() => ({}))) as {
    name?: string;
    visibility?: string;
    branch?: string;
    branch_head_hash?: string | null;
    revisions?: { seq?: number; root_hash?: string; missing?: boolean }[];
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    name: body.name ?? name,
    visibility: body.visibility ?? 'PRIVATE',
    branch: body.branch ?? branch ?? 'main',
    head: typeof body.branch_head_hash === 'string' ? body.branch_head_hash : null,
    revisions: (body.revisions ?? [])
      .filter((r): r is { seq: number; root_hash: string; missing?: boolean } =>
        typeof r.root_hash === 'string' && typeof r.seq === 'number')
      .map((r) => ({ seq: r.seq, root_hash: r.root_hash, missing: r.missing === true })),
  };
}

export interface SyncResult {
  /** 本次实际拉取入库的文档数（本地已有=跳过不计） */
  fetched: number;
  /** missing 版本数（文档行已被硬删的历史痕迹） */
  missing: number;
  /** 远端支 tip（null=空实例） */
  head: string | null;
  /** 拉取失败的 root_hash 列表（逐条已报过错） */
  failed: string[];
}

/** 把实例链上本地缺失的版本逐个拉进工作区（历史=对象，不动 direct——检出由调用方决定） */
export async function syncInstanceObjects(
  dataDir: string,
  remote: string,
  view: InstanceChainView,
  hasObject: (hash: string) => boolean
): Promise<SyncResult> {
  let fetched = 0;
  let missing = 0;
  const failed: string[] = [];
  for (const rev of view.revisions) {
    if (rev.missing) {
      missing++;
      continue;
    }
    if (hasObject(rev.root_hash)) continue;
    try {
      await fetchRemoteDoc(dataDir, remote, rev.root_hash);
      fetched++;
    } catch (e) {
      console.error(`pull failed: ${(e as Error).message}`);
      failed.push(rev.root_hash);
    }
  }
  return { fetched, missing, head: view.head, failed };
}

export type CheckoutOutcome =
  | { kind: 'up-to-date'; head: string }
  | { kind: 'fast-forward'; from: string; to: string }
  | { kind: 'checked-out'; head: string }
  | { kind: 'untouched'; reason: string };

/**
 * 远端 tip 落到本地 direct（git 的 fetch+checkout 收口，clone/pull 共用）：
 * - tip 已是 direct → up to date
 * - direct 恰一者在链上且不是 tip → fast-forward（该 direct 项替换为 tip）
 * - direct 无一在链上 → 检出：claimDirect(tip)（其余 direct 原样保留，提示带 hash 操作）
 * - 多者在链上 → 不动（歧义，交人工）
 */
export function checkoutTip(state: State, view: InstanceChainView): CheckoutOutcome {
  const tip = view.head;
  if (tip === null) return { kind: 'untouched', reason: 'the remote branch has no revisions yet' };
  if (state.direct.includes(tip)) return { kind: 'up-to-date', head: tip };
  const chainHashes = new Set(view.revisions.map((r) => r.root_hash));
  const onChain = state.direct.filter((h) => chainHashes.has(h));
  if (onChain.length === 1) {
    const from = onChain[0];
    state.direct = state.direct.map((h) => (h === from ? tip : h));
    (state.claims ??= {})[tip] = new Date().toISOString(); // 新 ref 的事件时间（换根=重盖）
    return { kind: 'fast-forward', from, to: tip };
  }
  if (onChain.length > 1) {
    return { kind: 'untouched', reason: `${onChain.length} local directs are on the remote chain — move to ${tip} by hand (edit/push take an explicit hash)` };
  }
  claimDirect(state, tip);
  return { kind: 'checked-out', head: tip };
}

/** checkoutTip 有落点时统一写盘 */
export function persistIfMoved(dataDir: string, state: State, outcome: CheckoutOutcome): void {
  if (outcome.kind === 'untouched') return;
  saveState(dataDir, state);
}
