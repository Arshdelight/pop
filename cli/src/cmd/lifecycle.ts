import { defaultDataDir, loadState } from '../state.js';
import { authedFetch } from '../client.js';

export interface LifecycleOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * pop submit [hash]：提交公开审核（PRIVATE → PENDING_REVIEW，自动机审通过后 PUBLISHED；此前已过审免二审）。
 * POST /api/v1/pop/:ref/submit。不带 hash 默认提交全部 direct roots（逐个尝试，非 PRIVATE 的跳过并计失败）。
 */
export async function runSubmit(opts: LifecycleOpts): Promise<number> {
  return runLifecycle(opts, 'submit', 'submitted');
}

/**
 * pop unpublish [hash]：撤回待审 / 下架已公开（PENDING_REVIEW|PUBLISHED → PRIVATE，退出公开检索）。
 * POST /api/v1/pop/:ref/unpublish。
 */
export async function runUnpublish(opts: LifecycleOpts): Promise<number> {
  return runLifecycle(opts, 'unpublish', 'unpublished');
}

/**
 * pop delete <hash>：删除自己在 remote 上的 DIRECT 认领（无认领的文档被硬删除）。
 * DELETE /api/v1/pop/:ref。必须显式给 hash（不做默认全删）；纯远端操作，本地工作区不动，
 * 再次 push 同内容会重建（新行，PRIVATE）。
 */
export async function runDelete(opts: LifecycleOpts): Promise<number> {
  if (opts.positional.length === 0) {
    console.error('usage: pop delete <hash>   (explicit hash required — no default)');
    return 1;
  }
  return runLifecycle(opts, undefined, 'deleted');
}

async function runLifecycle(
  opts: LifecycleOpts,
  action: 'submit' | 'unpublish' | undefined, // undefined → DELETE
  verb: string
): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }

  const refs = action === undefined ? opts.positional : (opts.positional[0] ? [opts.positional[0]] : state.direct);
  if (refs.length === 0) {
    console.error(action
      ? 'error: no direct pops to ' + action + ' (none registered)'
      : 'usage: pop delete <hash>');
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
