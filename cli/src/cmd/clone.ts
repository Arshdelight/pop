import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, loadState } from '../state.js';
import { exportSubtree, initWorkspace, loadWorkspace } from '@arshdelight/pop-sdk';
import { fetchInstanceChain, syncInstanceObjects } from '../sync.js';
import { chainHead, saveChain, workingFileFor, type ChainFile, type Repo } from '../practice.js';
import { shortHash } from '../render.js';

export interface CloneOpts {
  dataDir?: string;
  positional: string[];
  /** 克隆目标目录（实例文件夹位置）；缺省=cwd/<name> */
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
 * practi clone <owner>/<name>[@branch] [--dir <path>]：把一个实践实例克隆成本地
 * 实例文件夹——<name>.json 工作文件 + .practi/（全链历史，自包含）。此后的
 * commit/push/pull/log 都以 cwd 定位到它。
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

  const dir = path.resolve(opts.dir ?? path.join(process.cwd(), name));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    console.error(`clone failed: ${dir} already exists and is not empty`);
    return 1;
  }
  const poolDir = path.join(dir, '.practi');
  fs.mkdirSync(poolDir, { recursive: true });
  try {
    initWorkspace(poolDir);
  } catch {
    // practice.yaml 已在（半途重试）——沿用
  }

  const view = await fetchInstanceChain(dataDir, state.remote.url, owner, name, branch);
  const ws = loadWorkspace(poolDir);
  const sync = await syncInstanceObjects(dataDir, poolDir, state.remote.url, owner, name, view, (h) => ws.nodes.has(h));
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
  const repo: Repo = { dir, chain, chainPath: path.join(poolDir, 'chain.json'), filePath: workingFileFor(dir, name), poolDir };
  saveChain(repo);
  const head = chainHead(chain);
  if (head !== null) {
    const node = loadWorkspace(poolDir).nodes.get(head);
    if (node) {
      fs.writeFileSync(repo.filePath, JSON.stringify(exportSubtree(node, ws.nodes), null, 2) + '\n', 'utf8');
    }
  }

  console.log(`cloned:  ${owner}/${name} → ${dir}  (${view.visibility}, branch ${view.branch}, ${view.revisions.length} revision(s))`);
  if (sync.missing > 0) {
    console.log(`note: ${sync.missing} revision(s) missing on the hub (history traces of hard-deleted documents)`);
  }
  console.log(`head:    ${view.head ? shortHash(view.head) : '(empty)'}`);
  console.log(`next:    cd ${name} — edit ${name}.json, \`practi commit -m "..."\`, then \`practi push\``);
  return 0;
}
