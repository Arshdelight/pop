import { defaultDataDir, loadState } from '../state.js';
import { authedFetch } from '../client.js';
import { shortHash } from '../render.js';

export interface SearchOpts {
  dataDir?: string;
  positional: string[]; // 查询词（多个 positional 以空格连接，免引号）
  scope: string; // public | me | all
  limit: number;
  json: boolean;
}

interface SearchRow {
  root_hash: string;
  name: string;
  description: string | null;
  status: string;
  authorName: string | null;
  created_at: string;
}

/**
 * pop search <query...>：在 remote 上检索 POP（GET /api/v1/pop/search）。
 * - 标题与内容都参与匹配，标题命中优先（服务端排序）。
 * - --scope public=公开库（默认，仅 PUBLISHED）；me=自己 direct 认领（全状态）；all=并集。
 * - 空 q（`pop search`）返回最近文档，可当浏览用。
 */
export async function runSearch(opts: SearchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `pop remote set <url>` first');
    return 1;
  }
  if (!['public', 'me', 'all'].includes(opts.scope)) {
    console.error("error: invalid scope — expected public | me | all");
    return 1;
  }

  const q = opts.positional.join(' ').trim();
  const params = new URLSearchParams({ q, scope: opts.scope, limit: String(opts.limit) });
  const res = await authedFetch(dataDir, state.remote.url, `/api/v1/pop/search?${params.toString()}`);
  const body = (await res.json().catch(() => ({}))) as {
    results?: SearchRow[];
    total?: number;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    console.error(`search failed: ${detail}`);
    return 1;
  }

  const results = body.results ?? [];
  if (opts.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (results.length === 0) {
    console.log(q ? `no results for "${q}" (scope: ${opts.scope})` : `no documents yet (scope: ${opts.scope})`);
    return 0;
  }
  for (const r of results) {
    const desc = r.description ? ` — ${r.description}` : '';
    const author = r.authorName ? `  @${r.authorName}` : '';
    console.log(`  ${shortHash(r.root_hash)}  [${r.status}]  ${r.name}${desc}${author}`);
    console.log(`    ${r.root_hash}`);
  }
  console.log(`\n${results.length} shown (total ${body.total ?? results.length}, scope: ${opts.scope}) — fetch one with \`pop pull <hash>\``);
  return 0;
}
