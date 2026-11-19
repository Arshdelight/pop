import { authedFetch } from '../client.js';
import { defaultDataDir, loadState } from '../state.js';

export interface NotificationRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsOpts {
  dataDir?: string;
  limit?: number;
  since?: string;
  until?: string;
  json?: boolean;
}

/** kind → CLI 短标签（hub 存结构化 kind，web 文案走 i18n；CLI 用固定英文短词） */
const KIND_LABELS: Record<string, string> = {
  pop_approved: 'approved',
  pop_rejected: 'rejected',
  report_upheld: 'report upheld',
  issue_created: 'issue opened',
  issue_comment: 'issue reply',
  issue_hidden: 'hidden by review',
  appeal_overridden: 'appeal accepted',
  appeal_upheld: 'appeal upheld',
  feedback_replied: 'feedback replied',
};

function label(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 日期入参归一：纯 YYYY-MM-DD 补全为 UTC 全日窗（since=当日零点，until=次日零点闭区间
 *  语义靠 hub 端 lt）；带时间的 ISO 串原样透传。非法返回 null。 */
export function normalizeDateBound(value: string, edge: 'since' | 'until'): string | null {
  const t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const day = new Date(`${t}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) return null;
    if (edge === 'until') day.setUTCDate(day.getUTCDate() + 1); // 直到当日末（次日凌晨，hub 端 lt）
    return day.toISOString();
  }
  const full = new Date(t);
  return Number.isNaN(full.getTime()) || t.length < 10 ? null : full.toISOString();
}

/**
 * practi notifications：查询 hub 信箱（最近 N 条或 since/until 时间窗 + 未读数）。
 * 数据真相在 hub /api/v1/notifications（CLI 走 Bearer，practice:read scope 门控）；
 * 本命令只读不动已读状态——标记已读去 web 端（/notifications）做。
 */
export async function runNotifications(opts: NotificationsOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }

  let since: string | null | undefined;
  let until: string | null | undefined;
  if (opts.since) {
    since = normalizeDateBound(opts.since, 'since');
    if (!since) {
      console.error(`error: invalid --since value: ${opts.since} (use YYYY-MM-DD or ISO datetime)`);
      return 1;
    }
  }
  if (opts.until) {
    until = normalizeDateBound(opts.until, 'until');
    if (!until) {
      console.error(`error: invalid --until value: ${opts.until} (use YYYY-MM-DD or ISO datetime)`);
      return 1;
    }
  }

  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(Math.min(100, Math.max(1, opts.limit))));
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  const qs = params.toString();

  const res = await authedFetch(dataDir, state.remote.url, `/api/v1/notifications${qs ? `?${qs}` : ''}`);
  if (!res.ok) {
    const body = (await res.json()) as { error?: string; code?: string };
    console.error(`error: hub returned HTTP ${res.status}${body.code ? ` (${body.code})` : ''} — ${body.error ?? 'failed to list notifications'}`);
    return 1;
  }
  const data = (await res.json()) as { items?: NotificationRow[]; unread?: number };
  const items = data.items ?? [];

  if (opts.json) {
    console.log(JSON.stringify({ unread: data.unread ?? 0, items }, null, 2));
    return 0;
  }

  if (items.length === 0) {
    console.log(`no notifications${qs ? ' in the given range' : ''} (unread: ${data.unread ?? 0})`);
    return 0;
  }

  console.log(`${items.length} notification(s), unread: ${data.unread ?? 0}`);
  for (const n of items) {
    const at = n.createdAt.replace('T', ' ').slice(0, 16);
    const name = typeof n.payload.name === 'string' ? `: ${n.payload.name}` : '';
    const reason = typeof n.payload.reason === 'string' ? ` — ${n.payload.reason.slice(0, 100)}` : '';
    const flag = n.readAt ? ' ' : '*';
    console.log(`${flag} ${at}  ${label(n.kind).padEnd(16)}${name}${reason}`);
  }
  console.log('(* = unread; marking read happens on the hub web inbox)');
  return 0;
}
