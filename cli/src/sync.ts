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

/** GET 实例链视图（clone/pull 共用的口径） */
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

/** 把实例链上本地缺失的版本逐个拉进实例的 .practi 池（历史=对象；检出=调用方回写工作文件）。
 *  home=配置家（凭据），poolDir=实例池（字节落地）。 */
export async function syncInstanceObjects(
  home: string,
  poolDir: string,
  remote: string,
  owner: string,
  name: string,
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
      await fetchRemoteDoc(home, poolDir, remote, owner, name, rev.root_hash);
      fetched++;
    } catch (e) {
      console.error(`pull failed: ${(e as Error).message}`);
      failed.push(rev.root_hash);
    }
  }
  return { fetched, missing, head: view.head, failed };
}
