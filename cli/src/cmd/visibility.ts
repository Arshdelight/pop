import { authedFetch } from '../client.js';
import { defaultDataDir, loadState } from '../state.js';

export interface VisibilityOpts {
  dataDir?: string;
  positional: string[];
  json?: boolean;
}

/** practi visibility <owner>/<name> public|private — 实例可见性（pop#1：转公开去浏览器化）。
 *  public 方向 hub 受理进审核流（PUBLIC_REVIEWING，判定走通知）；private 即时生效可随时再来 */
export async function runVisibility(opts: VisibilityOpts): Promise<number> {
  const dir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const target = opts.positional[0];
  const mode = opts.positional[1];
  if (!target || !/^[^/]+\/[^/]+$/.test(target) || (mode !== 'public' && mode !== 'private')) {
    console.error('usage: practi visibility <owner>/<name> public|private');
    return 1;
  }
  const [owner, name] = target.split('/');
  const visibility = mode === 'public' ? 'PUBLIC' : 'PRIVATE';
  const res = await authedFetch(
    dir,
    state.remote.url,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility }),
    }
  );
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    const detail =
      typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : '';
    console.error(`error: hub returned HTTP ${res.status}${body.code ? ` (${String(body.code)})` : ''}${detail ? ` — ${detail}` : ''}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (visibility === 'PUBLIC') {
    console.log('publication requested — the hub accepted it into the review queue (PUBLIC_REVIEWING).');
    console.log('it stays invisible to others during review; the verdict lands in `practi notifications`.');
  } else {
    console.log('visibility set to PRIVATE — invisible to others now (re-publish anytime).');
  }
  return 0;
}
