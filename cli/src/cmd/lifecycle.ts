import { PracticeError, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { authedFetch, fetchMine } from '../client.js';
import { openWorkspace } from '../workspace.js';

export interface LifecycleOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi publish [hash]：尝试发布（PRIVATE → PENDING_REVIEW，自动机审通过后 PUBLISHED；此前已过审免二审）。
 * POST /api/v1/pop/:ref/submit（hub 端点名不变，这是 CLI 面孔）。不带 hash 默认发布全部 direct roots
 * （逐个尝试，非 PRIVATE 的跳过并计失败）。ref 支持短哈希：本地工作区解析，未命中回落我在
 * hub 上的认领前缀（唯一匹配才收）。
 */
export async function runPublish(opts: LifecycleOpts): Promise<number> {
  return runLifecycle(opts, 'submit', 'published');
}

/**
 * practi unpublish [hash]：撤回待审 / 下架已公开（PENDING_REVIEW|PUBLISHED → PRIVATE，退出公开检索）。
 * POST /api/v1/pop/:ref/unpublish。ref 同样支持短哈希。
 */
export async function runUnpublish(opts: LifecycleOpts): Promise<number> {
  return runLifecycle(opts, 'unpublish', 'unpublished');
}

/**
 * practi remove <hash> --remote：删除自己在 remote 上的 DIRECT 认领（无认领的文档被硬删除）。
 * DELETE /api/v1/pop/:ref。必须显式给 hash 且为全哈希（不做默认全删）；纯远端操作，本地工作区不动，
 * 再次 push 同内容会重建（新行，PRIVATE）。
 */
export async function runDelete(opts: LifecycleOpts): Promise<number> {
  if (opts.positional.length === 0) {
    console.error('usage: practi remove <hash> --remote   (explicit hash required — no default)');
    return 1;
  }
  return runLifecycle(opts, undefined, 'deleted');
}

/** 短哈希解析：全哈希直过；否则先本地工作区（resolveNodeRef，本地歧义即报），
 *  未命中再回落我在 hub 上的认领做前缀唯一匹配——两条登记簿都可能藏着这篇文档。 */
async function resolveClaimRef(dataDir: string, remoteUrl: string, ref: string): Promise<string> {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return `sha256:${hex}`;
  if (!/^[0-9a-f]{4,63}$/.test(hex)) {
    throw new Error(`"${ref}" is not a hash (full or ≥4-hex prefix)`);
  }
  try {
    return resolveNodeRef(openWorkspace(dataDir), ref);
  } catch (e) {
    if (e instanceof PracticeError && e.code === 'E_AMBIGUOUS') throw e;
    // 本地没有（含未初始化工作区）：hub 认领表兜底
    const mine = await fetchMine(dataDir, remoteUrl);
    const hits = mine.filter((r) => r.root_hash.startsWith(`sha256:${hex}`));
    if (hits.length === 0) {
      throw new Error(`${ref} is neither in the local workspace nor among your remote claims`);
    }
    if (hits.length > 1) {
      throw new Error(`hash prefix "${ref}" matches ${hits.length} of your remote claims — give more hex`);
    }
    return hits[0].root_hash;
  }
}

async function runLifecycle(
  opts: LifecycleOpts,
  action: 'submit' | 'unpublish' | undefined, // undefined → DELETE
  verb: string
): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }

  let refs: string[];
  if (action === undefined) {
    refs = opts.positional; // DELETE：全哈希要求，不解析
  } else if (opts.positional[0]) {
    try {
      refs = [await resolveClaimRef(dataDir, state.remote.url, opts.positional[0])];
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      return 1;
    }
  } else {
    refs = state.direct; // 默认全部 direct（本来就是全哈希）
  }
  if (refs.length === 0) {
    console.error(action
      ? 'error: no direct pops to ' + (action === 'submit' ? 'publish' : action) + ' (none registered)'
      : 'usage: practi remove <hash> --remote');
    return 1;
  }

  let failed = 0;
  for (const ref of refs) {
    try {
      const path = action === undefined
        ? `/api/v1/pop/${encodeURIComponent(ref)}`
        : `/api/v1/pop/${encodeURIComponent(ref)}/${action}`;
      const res = await authedFetch(dataDir, state.remote.url, path, {
        method: action === undefined ? 'DELETE' : 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        root_hash?: string; status?: string; message?: string; error?: string; code?: string;
      };
      if (!res.ok) {
        const detail = body.code ? `${body.code}: ${body.message ?? body.error}` : (body.message ?? body.error ?? `HTTP ${res.status}`);
        console.error(`${verb} failed: ${ref} — ${detail}`);
        failed++;
        continue;
      }
      console.log(`${verb}: ${body.root_hash ?? ref}  (${body.status ?? ''})`);
    } catch (e) {
      console.error(`${verb} failed: ${ref} — ${(e as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}
