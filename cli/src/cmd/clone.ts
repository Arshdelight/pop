import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, loadState } from '../state.js';
import { initDataDir, openWorkspace } from '../workspace.js';
import { fetchInstanceChain, syncInstanceObjects } from '../sync.js';
import { chainPathFor, saveChain, type ChainFile } from '../practice.js';
import { shortHash } from '../render.js';

export interface CloneOpts {
  dataDir?: string;
  positional: string[];
  /** 克隆为独立目录实例（目录即仓库，自带节点池）；缺省=默认工作目录账本登记 */
  dir?: string;
}

/** `practi clone <owner>/<name>[@branch]` 的 ref 形态（分支段可选，缺省=实例默认支） */
export function parseCloneRef(ref: string): { owner: string; name: string; branch?: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)\/([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?)(?:@([a-z0-9][a-z0-9-]{0,38}[a-z0-9]?))?$/.exec(ref);
  if (!m) return null;
  const [, owner, name, branch] = m;
  return { owner, name, branch };
}

/**
 * practi clone <owner>/<name>[@branch] [--dir <path>]：把一个实践实例克隆成本地实例仓库。
 * - 全链修订拉入实例节点池（历史=对象），链文件与 hub 链同构落盘（全部盖 pushedAt）
 * - registry 式（缺省）：登记进默认工作目录 practices/<name>/；--dir：目录即仓库
 * - 此后的 push/pull/log/publish 都以 cwd / --dir / --practice 定位到它
 */
export async function runClone(opts: CloneOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const ref = opts.positional[0];
  const parsed = ref ? parseCloneRef(ref) : null;
  if (!parsed) {
    console.error('usage: practi clone <owner>/<name>[@branch] [--dir <path>]');
    return 1;
  }
  const { owner, name, branch } = parsed;

  const view = await fetchInstanceChain(dataDir, state.remote.url, owner, name, branch);

  // 目标实例仓库（registry 式重名守卫）
  const repoDir = opts.dir ? path.resolve(opts.dir) : dataDir;
  const chainPath = opts.dir ? path.join(repoDir, 'chain.json') : chainPathFor(dataDir, name);
  if (fs.existsSync(chainPath)) {
    console.error(`clone failed: ${opts.dir ? opts.dir : name} already exists locally (chain.json present)`);
    return 1;
  }
  if (opts.dir) {
    fs.mkdirSync(repoDir, { recursive: true });
    initDataDir(repoDir);
  }

  const poolDir = repoDir;
  const ws = openWorkspace(poolDir);
  const sync = await syncInstanceObjects(poolDir, state.remote.url, owner, name, view, (h) => ws.nodes.has(h));
  if (sync.failed.length > 0) {
    console.error(`clone incomplete: ${sync.failed.length} revision(s) failed to fetch`);
    return 1;
  }

  // 链文件：视图 tip 在前 → 反转即链序；全部盖 pushedAt（与 hub 已同步）
  const now = new Date().toISOString();
  const ordered = view.revisions.slice().reverse();
  const chain: ChainFile = {
    schema: 1,
    name,
    owner,
    current: view.branch,
    branches: { [view.branch]: view.head },
    commits: ordered.map((r, i) => ({
      seq: i + 1,
      root: r.root_hash,
      parent: i > 0 ? ordered[i - 1].root_hash : null,
      message: `cloned from ${owner}/${name}`,
      pushedAt: now,
    })),
  };
  fs.mkdirSync(path.dirname(chainPath), { recursive: true });
  fs.writeFileSync(chainPath, JSON.stringify(chain, null, 2) + '\n', 'utf8');
  saveChain({ kind: opts.dir ? 'directory' : 'registry', dataDir: repoDir, chainPath, chain });

  console.log(`cloned:  ${owner}/${name} (${view.visibility}, branch ${view.branch}, ${view.revisions.length} revision(s))`);
  if (sync.missing > 0) {
    console.log(`note: ${sync.missing} revision(s) missing on the hub (history traces of hard-deleted documents)`);
  }
  console.log(`head:    ${view.head ? shortHash(view.head) : '(empty)'}`);
  console.log('next:    `practi log` for its history; publish a changed pop with `practi publish <pop> --to ' + name + '`');
  return 0;
}
