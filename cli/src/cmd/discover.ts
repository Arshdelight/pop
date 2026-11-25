import { defaultDataDir, loadState } from '../state.js';
import { loadCredentials } from '../credentials.js';
import { fetchMyInstances, fetchPublicInstances, type RemoteInstance } from '../client.js';

/**
 * hub 发现面（2026-11-25）：`practi ls --remote` 与 `practi search --remote` 的实现。
 * 数据真相在 hub——GET /api/v1/instances（我的，owner 全量视角）与
 * GET /api/v1/search/instances（公开，匿名）。两个都是 anywhere 命令，不碰实践文件夹。
 * 结果行带 owner/name，复制即可 `practi clone`。
 */

const CLONE_HINT = 'get one down with `practi clone <owner>/<name>`';
const LOGIN_NOTE = '(log in with `practi login` to include your own practices)';

const key = (r: RemoteInstance): string => `${r.owner}/${r.name}`;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** PUBLIC_REVIEWING → reviewing；其余小写原样 */
function visibilityLabel(visibility: string): string {
  return visibility === 'PUBLIC_REVIEWING' ? 'reviewing' : visibility.toLowerCase();
}

function day(iso: string | null): string {
  return iso === null || Number.isNaN(Date.parse(iso)) ? '-' : iso.slice(0, 10);
}

function jsonRow(r: RemoteInstance): Record<string, unknown> {
  return {
    owner: r.owner,
    name: r.name,
    visibility: r.visibility,
    title: r.title,
    description: r.excerpt,
    revisions: r.revisions,
    updated: r.updatedAt,
  };
}

function printHit(r: RemoteInstance, refW: number, mine: boolean): void {
  const ref = `  ${key(r)}`.padEnd(refW + 2);
  const vis = (mine ? visibilityLabel(r.visibility) : '').padEnd(9);
  console.log(`${ref}  ${vis}  ${clip(r.title ?? r.name, 80)}`);
  if (r.excerpt !== null) console.log(`${' '.repeat(refW + 15)}${clip(r.excerpt, 100)}`);
}

export interface LsRemoteOpts {
  dataDir?: string;
  json?: boolean;
}

/** practi ls --remote：我在 hub 上的全部实践（私密/审核中/公开），按最近更新排 */
export async function runLsRemote(opts: LsRemoteOpts): Promise<number> {
  const home = opts.dataDir ?? defaultDataDir();
  const state = loadState(home);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const rows = await fetchMyInstances(home, state.remote.url);

  if (opts.json) {
    console.log(JSON.stringify(rows.map(jsonRow), null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log('no practices on the hub yet — `practi push` inside a practice folder creates one');
    return 0;
  }
  const nameW = Math.min(Math.max(...rows.map((r) => r.name.length), 4), 40);
  console.log(`${'name'.padEnd(nameW)}  visibility  revs  updated     head`);
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(nameW)}  ${visibilityLabel(r.visibility).padEnd(10)}  ${String(r.revisions).padStart(4)}  ${day(r.updatedAt)}  ${clip(r.title ?? '(no revision yet)', 80)}`
    );
  }
  console.log(`\n${rows.length} practice(s) on the hub as ${rows[0].owner} — get one down with \`practi clone <name>\``);
  return 0;
}

export interface SearchRemoteOpts {
  dataDir?: string;
  /** 查询词；多词 = AND（与本地 search 同约定），全空 = 浏览最近更新的公开实践 */
  positional: string[];
  limit: number;
  json: boolean;
}

/** practi search --remote [query...]：公开实践（hub 排名）+ 我自己的（按名字/描述匹配，排前面） */
export async function runSearchRemote(opts: SearchRemoteOpts): Promise<number> {
  const home = opts.dataDir ?? defaultDataDir();
  const state = loadState(home);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const remote = state.remote.url;
  const terms = opts.positional.join(' ').split(/\s+/).filter((t) => t !== '');
  const browse = terms.length === 0;

  // 多词 = AND：hub 的词法检索按整串匹配（「部署 阿里云」要求这五个字连着出现），所以拆词
  // 各查一次，再按 owner/name 取交集，保留首词的排名序。每词最多取 hub 给的 50 条，常见词
  // 超出的部分不进交集（当前库量下够用）。
  const hits = new Map<string, RemoteInstance>();
  let publicTotal = 0;
  for (const [i, term] of (browse ? [''] : terms).entries()) {
    const page = await fetchPublicInstances(remote, term, browse ? opts.limit : 50);
    if (page === null) {
      console.error('error: this hub cannot list or search its practices yet — it needs practihub v0.2.22 or later');
      return 1;
    }
    if (i === 0) {
      for (const r of page.results) hits.set(key(r), r);
      publicTotal = page.total;
    } else {
      const seen = new Set(page.results.map(key));
      for (const k of hits.keys()) if (!seen.has(k)) hits.delete(k);
    }
  }

  // 我的：登录后按名字/描述过滤（hub 的检索面只有公开头，私密的只能这样找）。
  // 与公开命中重叠的（我自己已公开的）只列在「mine」里，带上可见性。
  let mine: RemoteInstance[] = [];
  const signedIn = loadCredentials(home) !== null;
  if (signedIn && !browse) {
    try {
      const all = await fetchMyInstances(home, remote);
      mine = all.filter((r) => {
        const haystack = `${r.name} ${r.title ?? ''} ${r.excerpt ?? ''}`.toLowerCase();
        return terms.every((t) => haystack.includes(t.toLowerCase()));
      });
    } catch (e) {
      // 公开结果仍然有价值：不因登录态失效让整条命令失败
      console.error(`warning: your own practices were not searched — ${(e as Error).message}`);
    }
  }
  const mineKeys = new Set(mine.map(key));
  const mineShown = mine.slice(0, opts.limit);
  const pubShown = [...hits.values()].filter((r) => !mineKeys.has(key(r))).slice(0, opts.limit);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          query: terms.join(' '),
          mode: browse ? 'browse' : 'search',
          results: [...mineShown.map((r) => ({ ...jsonRow(r), mine: true })), ...pubShown.map((r) => ({ ...jsonRow(r), mine: false }))],
          public_total: browse ? publicTotal : hits.size,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (browse) {
    if (pubShown.length === 0) {
      console.log('no public practices on the hub yet');
      return 0;
    }
    console.log('public practices on the hub, newest first');
    for (const r of pubShown) printHit(r, refWidth(pubShown), false);
    const more = publicTotal > pubShown.length ? ` (${publicTotal} in total)` : '';
    console.log(`\n${pubShown.length} shown${more} — ${CLONE_HINT}; your own: \`practi ls --remote\``);
    return 0;
  }

  if (mineShown.length === 0 && pubShown.length === 0) {
    console.log(`no practices on the hub match "${terms.join(' ')}"`);
    console.log('  the hub search matches wording — try fewer or different words');
    if (!signedIn) console.log(`  ${LOGIN_NOTE}`);
    return 0;
  }
  const refW = refWidth([...mineShown, ...pubShown]);
  if (mineShown.length > 0) {
    console.log('mine');
    for (const r of mineShown) printHit(r, refW, true);
  }
  if (pubShown.length > 0) {
    console.log('public');
    for (const r of pubShown) printHit(r, refW, false);
  }
  console.log(`\n${mineShown.length + pubShown.length} matched — ${CLONE_HINT}`);
  if (!signedIn) console.log(LOGIN_NOTE);
  return 0;
}

function refWidth(rows: RemoteInstance[]): number {
  return Math.min(Math.max(4, ...rows.map((r) => key(r).length)), 48);
}
