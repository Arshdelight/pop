import { createFromDoc, parseDocument } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { authedFetch, fetchMine } from '../client.js';

export interface PullOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi pull [hash]：把 hub 上「我的」认领同步到本地（git pull 语义）。
 * - 分页取 hub 我的认领表（mine），diff 出本地还没认领的，逐个拉文档体并注册为 direct。
 * - 只碰「我的认领」——不涉及公共库，因此不需要归属判断（mine 里的都是自己的）。
 * - 带 hash：只同步 mine 中的那一个；ref 口径与 show 的节点寻址一致
 *   （sha256: 前缀可选、≥4 hex 唯一前缀，见 matchClaimRef）。不在 mine 里 → 公共内容请用 `practi clone`。
 */

/** matchClaimRef 的失败分层：ref 形态不合法 / 合法但认领表无命中 / 前缀歧义 */
export type ClaimRefMatch =
  | { ok: true; rootHash: string }
  | { ok: false; code: 'format' | 'not-found' | 'ambiguous'; message: string };

/**
 * 在远程认领表里按 ref 定位 root_hash——口径对齐 SDK resolveNodeRef（§3 节点寻址）：
 * sha256: 前缀可选、大小写不敏感、≥4 hex 唯一前缀、歧义列候选。
 * 格式不合法 ≠ 认领不存在：分层报错，别把「没接受这个 ref」误报成「不是你的认领」。
 */
export function matchClaimRef(mine: { root_hash: string }[], ref: string): ClaimRefMatch {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(hex)) {
    return {
      ok: false,
      code: 'format',
      message: `"${ref}" is not a hash ref — use the full sha256 root hash or a unique prefix (≥4 hex digits)`,
    };
  }
  const hits = mine
    .map((r) => r.root_hash)
    .filter((h) => h.slice('sha256:'.length).toLowerCase().startsWith(hex));
  if (hits.length === 1) return { ok: true, rootHash: hits[0] };
  if (hits.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      message: `hash prefix "${ref}" matches ${hits.length} of your claims — lengthen the prefix: ${hits.slice(0, 5).join(', ')}`,
    };
  }
  return {
    ok: false,
    code: 'not-found',
    message: `${ref} is not in your claims on the remote — for public content use \`practi clone\``,
  };
}
export async function runPull(opts: PullOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const remote = state.remote.url;

  // 分页取 hub 我的认领表（diff 基准）
  let mine: { root_hash: string; status: string; name?: string }[];
  try {
    mine = await fetchMine(dataDir, remote);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }

  let hashes: string[];
  if (opts.positional[0]) {
    const match = matchClaimRef(mine, opts.positional[0]);
    if (!match.ok) {
      console.error(`error: ${match.message}`);
      return 1;
    }
    hashes = [match.rootHash];
  } else {
    hashes = mine.map((r) => r.root_hash);
  }

  const local = new Set(loadState(dataDir).direct);
  const toPull = hashes.filter((h) => !local.has(h)); // 本地缺失的认领
  if (toPull.length === 0) {
    console.log(mine.length === 0 ? 'nothing to pull (no own documents on the remote)' : 'up to date — nothing new to pull');
    return 0;
  }

  let failed = 0;
  for (const ref of toPull) {
    failed += await pullOne(dataDir, remote, ref);
  }

  // 提示本地认领而 hub 还没有的（用 push 同步）
  const localOnly = [...local].filter((h) => !mine.some((r) => r.root_hash === h));
  if (localOnly.length > 0) {
    console.log(`note: ${localOnly.length} direct POP(s) exist only locally — run \`practi push\` to sync`);
  }
  return failed ? 1 : 0;
}

async function pullOne(dataDir: string, remote: string, ref: string): Promise<number> {
  const res = await authedFetch(dataDir, remote, `/api/v1/pop/${encodeURIComponent(ref)}`);
  const body = (await res.json().catch(() => ({}))) as {
    document?: unknown;
    status?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`pull failed: ${ref} — ${detail}`);
    return 1;
  }
  if (body.document === undefined || body.document === null) {
    console.error(`pull failed: ${ref} — response missing document`);
    return 1;
  }

  // 入库前验算（内容寻址的客户端责任，hub 读路径不代验）：纯导入（不落库）算出的
  // 根哈希必须等于请求地址——不符即拒绝，防止「另一身份的文档被悄悄注册为我的认领」
  let computedRoot: string;
  try {
    computedRoot = parseDocument(body.document).rootHash;
  } catch (e) {
    console.error(`pull failed: ${ref} — invalid document: ${(e as Error).message}`);
    return 1;
  }
  if (computedRoot !== ref) {
    console.error(`pull failed: ${ref} — hash mismatch: content hashes to ${computedRoot}`);
    return 1;
  }

  const ws = openWorkspace(dataDir);
  const { root } = createFromDoc(ws, body.document);

  const state = loadState(dataDir);
  if (!state.direct.includes(root)) {
    state.direct.push(root);
    saveState(dataDir, state);
  }
  console.log(`pulled:  ${root}  (${body.status ?? 'PUBLISHED'})  [direct]`);
  return 0;
}
