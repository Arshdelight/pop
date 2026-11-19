import { authedFetch, normalizeHashRef } from '../client.js';
import { defaultDataDir, loadState } from '../state.js';

interface AppealItem {
  id: string;
  root_hash: string;
  status: 'PENDING' | 'OVERRIDDEN' | 'UPHELD';
  decision_note: string | null;
  created_at: string;
  handled_at: string | null;
}

export interface AppealOpts {
  dataDir?: string;
  action: string;
  positional: string[];
  root?: string;
  reason?: string;
  json?: boolean;
}

const USAGE_LINES = [
  'usage: practi appeal submit <owner>/<name> --root <sha256|64hex> --reason <text>',
  '       (file a review appeal for a rejected version; the hub resolves the',
  '        offending pop server-side — inherited rejections included)',
  'usage: practi appeal list <owner>/<name> [--json]',
  '       (your appeals for this instance + the head review state)',
];

export async function runAppeal(opts: AppealOpts): Promise<number> {
  const dir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const remote = state.remote.url;
  const target = opts.positional[0];
  if (!target || !/^[^/]+\/[^/]+$/.test(target)) {
    console.error(USAGE_LINES.join('\n'));
    return 1;
  }
  const [owner, name] = target.split('/');
  const path = `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/appeals`;

  if (opts.action === 'submit') {
    const root = opts.root ? normalizeHashRef(opts.root) : null;
    if (!root) {
      console.error('error: --root expects a sha256 hash (sha256:-prefixed or bare 64-hex)');
      return 1;
    }
    const reason = (opts.reason ?? '').trim();
    if (!reason) {
      console.error('error: --reason is required — say what the machine got wrong and why (≤2000 chars)');
      return 1;
    }
    const res = await authedFetch(dir, remote, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootHash: root, reason }),
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      console.error(
        `error: hub returned HTTP ${res.status}${body.code ? ` (${String(body.code)})` : ''} — ${
          typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : 'appeal rejected'
        }`
      );
      return 1;
    }
    if (opts.json) {
      console.log(JSON.stringify(body, null, 2));
      return 0;
    }
    console.log(`appeal filed: ticket ${String(body.id ?? '')}`.trimEnd());
    console.log('the hub targets the offending pop automatically (direct or inherited rejection).');
    console.log(`outcome arrives as a hub notification — check \`practi notifications\`.`);
    return 0;
  }

  if (opts.action === 'list') {
    const res = await authedFetch(dir, remote, path);
    const body = (await res.json().catch(() => ({}) as Record<string, unknown>)) as {
      items?: AppealItem[];
      head?: { review_result?: string | null } | null;
    };
    if (!res.ok) {
      console.error(`error: hub returned HTTP ${res.status} — failed to list appeals`);
      return 1;
    }
    const items = body.items ?? [];
    if (opts.json) {
      console.log(JSON.stringify(body, null, 2));
      return 0;
    }
    const headState = body.head?.review_result ?? 'NOT_REVIEWED';
    console.log(`head review state: ${headState}`);
    if (items.length === 0) {
      console.log('no appeals filed for this instance');
      return 0;
    }
    for (const a of items) {
      const at = a.created_at.replace('T', ' ').slice(0, 16);
      const note = a.decision_note ? ` — ${a.decision_note.slice(0, 90)}` : '';
      console.log(`${at}  ${a.status.padEnd(10)}  ${a.root_hash.slice(0, 17)}…${note}`);
    }
    return 0;
  }

  console.error(USAGE_LINES.join('\n'));
  return 1;
}
