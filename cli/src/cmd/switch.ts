import { defaultDataDir, loadState, saveState } from '../state.js';
import { authedFetch } from '../client.js';

export interface SwitchOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi switch <branch>：切换工作区绑定的实例分支（git switch 同构——只动本地指针，
 * 不拉文档；把内容带进工作区用 `practi pull`）。远端无此支 → 报错不动。
 */
export async function runSwitch(opts: SwitchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  if (!state.instance) {
    console.error('error: no instance bound — use `practi instance bind <owner>/<name>` first');
    return 1;
  }
  const targetBranch = opts.positional[0];
  if (!targetBranch) {
    console.error('usage: practi switch <branch>');
    return 1;
  }
  const { owner, name } = state.instance;
  const res = await authedFetch(
    dataDir,
    state.remote.url,
    `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?branch=${encodeURIComponent(targetBranch)}`
  );
  const body = (await res.json()) as unknown as { branch?: string; error?: string; message?: string };
  if (!res.ok) {
    const detail = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    console.error(`error: ${detail}`);
    return 1;
  }
  state.instance = { ...state.instance, branch: body.branch ?? targetBranch };
  saveState(dataDir, state);
  console.log(`switched to branch: ${state.instance.branch} (on ${owner}/${name})`);
  return 0;
}
