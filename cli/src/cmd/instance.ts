import { defaultDataDir, loadState, saveState } from '../state.js';
import { authedFetch } from '../client.js';

export interface InstanceOpts {
  dataDir?: string;
  positional: string[];
  publicVisibility?: boolean;
  desc?: string;
}

interface InstanceView {
  name: string;
  description?: string | null;
  visibility: string;
  owner: { account: string; displayName?: string | null };
  head_hash?: string | null;
  branches?: { name: string; head_hash: string | null; is_default: boolean }[];
  branch?: string;
  revisions?: { seq: number; root_hash: string; name: string | null; status: string; missing: boolean }[];
}

/**
 * practi instance — 工作区 ↔ 实例绑定（git 的 origin 同构）：
 *   create <name>  建实例并绑定（--public 公开、--desc 一句话描述）；owner=当前登录账号
 *   bind <owner>/<name>  绑定既有实例（当前支=其默认支）
 *   show   显示绑定与实例概要
 * 绑定写进 practi.json 的 instance 字段（owner/name/branch），push/merge/log 缺省读它。
 */
export async function runInstance(opts: InstanceOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const action = opts.positional[0];

  if (action === 'create') {
    const name = opts.positional[1];
    if (!name) {
      console.error('usage: practi instance create <name> [--public] [--desc <text>]');
      return 1;
    }
    const res = await authedFetch(dataDir, state.remote.url, '/api/v1/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        visibility: opts.publicVisibility ? 'PUBLIC' : 'PRIVATE',
        ...(opts.desc !== undefined && opts.desc !== '' ? { description: opts.desc } : {}),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
      return 1;
    }
    // 实例在登录账号名下：owner=me（/api/auth/me 的 username 即 /u 路由坐标）
    const me = await authedFetch(dataDir, state.remote.url, '/api/auth/me');
    const meBody = await me.json();
    if (!me.ok || typeof meBody.username !== 'string') {
      console.error('error: instance created, but fetching your account failed — run `practi instance bind <owner>/<name>`');
      return 1;
    }
    state.instance = { owner: meBody.username, name: String(body.name ?? name), branch: 'main' };
    saveState(dataDir, state);
    console.log(`instance created and bound: ${state.instance.owner}/${state.instance.name} (${body.visibility ?? 'PRIVATE'}, branch main)`);
    console.log('next: `practi push <hash>` to bind the first revision');
    return 0;
  }

  if (action === 'bind') {
    const ref = opts.positional[1];
    const m = ref ? /^([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)\/([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)$/.exec(ref) : null;
    if (!m) {
      console.error('usage: practi instance bind <owner>/<name>');
      return 1;
    }
    const [, owner, name] = m;
    const res = await authedFetch(
      dataDir,
      state.remote.url,
      `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    );
    const body = (await res.json()) as unknown as InstanceView & { error?: string; message?: string };
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
      return 1;
    }
    state.instance = { owner, name, branch: body.branch ?? 'main' };
    saveState(dataDir, state);
    console.log(`bound: ${owner}/${name} (${body.visibility}, branch ${state.instance.branch})`);
    return 0;
  }

  if (action === 'show') {
    if (!state.instance) {
      console.error('error: no instance bound — use `practi instance create <name>` or `practi instance bind <owner>/<name>`');
      return 1;
    }
    const { owner, name, branch } = state.instance;
    const res = await authedFetch(
      dataDir,
      state.remote.url,
      `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?branch=${encodeURIComponent(branch)}`
    );
    const body = (await res.json()) as unknown as InstanceView & { error?: string; message?: string };
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      console.error(`error: ${detail}`);
      return 1;
    }
    console.log(`instance:  ${owner}/${name}`);
    console.log(`branch:    ${body.branch ?? branch}`);
    console.log(`visibility: ${body.visibility}`);
    console.log(`revisions: ${body.revisions?.length ?? 0} (on ${body.branch ?? branch})`);
    for (const b of body.branches ?? []) {
      console.log(`  ${b.is_default ? '*' : ' '} ${b.name}`);
    }
    return 0;
  }

  console.error('usage: practi instance create <name> [--public] [--desc <text>] | bind <owner>/<name> | show');
  return 1;
}
