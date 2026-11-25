import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../state.js';
import { chainPathFor, loadChain } from '../practice.js';
import { shortHash } from '../render.js';
import { runLsRemote } from './discover.js';

export interface LsOpts {
  dataDir?: string;
  json?: boolean;
  /** 列 hub 上我的实例（owner 全量视角），不扫本地家目录 */
  remote?: boolean;
}

/**
 * practi ls [--json]：practices 家目录的跨实践概览（anywhere 命令，cwd 无关）。
 * 家目录 = 配置家下的 practices/（与 `practi web` 家目录总览同源同判定：子目录含
 * .practi/chain.json 即收录）。unpushed = 全链 pushedAt 缺失的提交数——与 push 的
 * dirtyChain 判定同口径（本地 commit 未推、reword/squash 重写清戳都计入；push 后归零）。
 * 2026-11-18 恢复：旧集中 workspace 的 direct/indirect 注册表语义已随实例文件夹模型
 * 退役（4ab7987），本命令是新语义重写，不是旧实现复用。
 */
export async function runLs(opts: LsOpts): Promise<number> {
  if (opts.remote === true) return runLsRemote(opts);
  const home = path.join(opts.dataDir ?? defaultDataDir(), 'practices');

  interface Entry {
    name: string;
    branch: string;
    head: string | null;
    revisions: number;
    unpushed: number;
    updated: string | null;
  }
  const entries: Entry[] = [];

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    dirs = []; // 家目录缺省 = 空态（init 前跑 ls 不炸）
  }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const chain = loadChain(chainPathFor(path.join(home, d.name)));
    if (!chain) continue;
    let updated: string | null = null;
    try {
      updated = fs.statSync(chainPathFor(path.join(home, d.name))).mtime.toISOString();
    } catch { /* 无从考据就不显示 */ }
    const tip = chain.commits[chain.commits.length - 1] ?? null;
    entries.push({
      name: chain.name || d.name,
      branch: chain.current,
      head: tip ? tip.root : null,
      revisions: chain.commits.length,
      unpushed: chain.commits.filter((c) => c.pushedAt === undefined).length,
      updated,
    });
  }
  entries.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.name.localeCompare(b.name));

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log(`(no practices in ${home} — create one with \`practi new <name>\`, or \`practi clone <owner>/<name>\`)`);
    return 0;
  }

  const nameW = Math.min(Math.max(...entries.map((e) => e.name.length), 4), 28);
  console.log(`${'name'.padEnd(nameW)}  branch       head          revs  unpushed`);
  for (const e of entries) {
    console.log(
      `${e.name.padEnd(nameW)}  ${e.branch.padEnd(12)}${(e.head ? shortHash(e.head) : '-').padEnd(14)}` +
        `${String(e.revisions).padStart(4)}  ${e.unpushed > 0 ? String(e.unpushed).padStart(8) : '-'.padStart(8)}`
    );
  }
  return 0;
}
