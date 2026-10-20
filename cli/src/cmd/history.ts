import fs from 'node:fs';
import { createFromDoc, exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import {
  chainHead,
  resolvePractice,
  saveChain,
  type ChainCommit,
  type PracticeRepo,
} from '../practice.js';
import { stripAttachmentUrls } from './push.js';
import { shortHash } from '../render.js';

export interface HistoryOpts {
  dataDir?: string;
  positional: string[];
  dir?: string;
  practice?: string;
  message?: string;
  file?: string;
  json?: string;
}

/** 重排 seq 为 1..n 连续（链重写后统一收口） */
function renumber(chain: PracticeRepo['chain']): void {
  chain.commits.sort((a, b) => a.seq - b.seq);
  chain.commits.forEach((c, i) => (c.seq = i + 1));
}

/** 重写收口：清全链 pushedAt（对账靠 push --force），悬空支指针修到存活祖先 */
function dirty(repo: PracticeRepo): void {
  const alive = new Set(repo.chain.commits.map((c) => c.root));
  const oldParents = new Map(repo.chain.commits.map((c) => [c.root, c.parent] as const));
  rewriteSettle(repo, alive, oldParents);
}

function findCommit(repo: PracticeRepo, seqStr: string): ChainCommit | null {
  const seq = Number(seqStr);
  const c = repo.chain.commits.find((x) => x.seq === seq);
  if (!c) console.error(`error: no commit v${seqStr} in ${repo.chain.name} (practi log)`);
  return c ?? null;
}

/** 重写收口：清全链 pushedAt + 修悬空支指针。
 *  指向已不存在 root 的支 → 重置到该 root 在旧 parent 链上仍存活的最近祖先
 *  （找不到就置 null 空支）——与 hub「支指针必须落在新链上」的对账规则一致。 */
function rewriteSettle(repo: PracticeRepo, alive: Set<string>, oldParents: Map<string, string | null>): void {
  for (const [b, r] of Object.entries(repo.chain.branches)) {
    if (r === null || alive.has(r)) continue;
    let cur: string | null = r;
    let moved: string | null = null;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      if (alive.has(cur)) {
        moved = cur;
        break;
      }
      cur = oldParents.get(cur) ?? null;
    }
    repo.chain.branches[b] = moved;
  }
  for (const c of repo.chain.commits) delete c.pushedAt;
  saveChain(repo);
  console.log('note:    the local chain diverged from the hub — `practi push --force` to overwrite (the hub drops unreachable objects)');
}

/**
 * practi history — 实例提交链的本地重写（push 时与 hub 对账）：
 *   history amend [<pop-ref|file>] [-m <msg>]   改支头：给文档=换内容，只给 -m=改说明
 *   history reword <seq> -m <msg>               改任意条提交说明（root 不变）
 *   history squash <seq>                        合并 seq 与 seq+1（内容取 seq+1，说明拼接）
 *   history drop <seq>                          删除中间某条提交（其后 parent 接前）
 *   history reset <seq>                         支头回退到 seq（其后提交丢弃）
 * 已推送的链同样可改——push 时分叉报错，--force 用本地链覆盖（hub 清不可达对象）。
 */
export async function runHistory(opts: HistoryOpts): Promise<number> {
  const action = opts.positional[0];
  if (!action) {
    console.error('usage: practi history amend [<pop-ref|file>] [-m <msg>] | reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const repo = resolvePractice({ dataDir, explicitDir: opts.dir, explicitName: opts.practice, verb: 'history' });
  if (repo === null) return 1;
  const chain = repo.chain;

  if (action === 'amend') {
    const head = chainHead(chain);
    const tip = chain.commits.find((c) => c.root === head);
    if (head === null || !tip) {
      console.error('error: the practice has no revisions to amend');
      return 1;
    }
    const poolDir = repo.kind === 'directory' ? repo.dataDir : dataDir;
    const hasDoc = opts.file !== undefined || opts.json !== undefined || opts.positional[1] !== undefined;
    if (hasDoc) {
      let text: string | undefined;
      if (opts.json !== undefined) text = opts.json;
      else if (opts.file !== undefined) text = fs.readFileSync(opts.file, 'utf8');
      else text = fs.readFileSync(opts.positional[1], 'utf8');
      let doc: unknown;
      try {
        doc = JSON.parse(text!);
      } catch (e) {
        console.error(`error [E_JSON]: ${(e as Error).message}`);
        return 1;
      }
      const ws = openWorkspace(poolDir);
      let newRoot: string;
      try {
        newRoot = createFromDoc(ws, doc as Record<string, unknown>).root;
      } catch (e) {
        console.error(`error [E_SCHEMA]: ${(e as Error).message}`);
        return 1;
      }
      tip.root = newRoot;
      chain.branches[chain.current] = newRoot;
    }
    if (opts.message !== undefined) tip.message = opts.message;
    dirty(repo);
    console.log(`amended: v${tip.seq}  ${shortHash(tip.root)}  ${tip.message}`);
    return 0;
  }

  if (action === 'reword') {
    const tip = findCommit(repo, opts.positional[1] ?? '');
    if (!tip) return 1;
    if (opts.message === undefined) {
      console.error('usage: practi history reword <seq> -m <msg>');
      return 1;
    }
    tip.message = opts.message;
    dirty(repo);
    console.log(`reworded: v${tip.seq}  ${shortHash(tip.root)}  ${tip.message}`);
    return 0;
  }

  if (action === 'squash') {
    const first = findCommit(repo, opts.positional[1] ?? '');
    if (!first) return 1;
    const second = chain.commits.find((c) => c.seq === first.seq + 1);
    if (!second) {
      console.error(`error: v${first.seq} has no successor to squash into it`);
      return 1;
    }
    // 内容取后者的 root（squash = 两次编辑折叠成一次落定），parent 保持 first 的原 parent
    // （合并条取代「first+second」整段），说明拼接；支指针若指在被并条目上随内容落点修正
    first.root = second.root;
    first.message = `${first.message}\n${second.message}`;
    chain.commits = chain.commits.filter((c) => c !== second);
    for (const [b, r] of Object.entries(chain.branches)) {
      if (r === second.root) chain.branches[b] = first.root;
    }
    renumber(chain);
    dirty(repo);
    console.log(`squashed: v${first.seq}+v${first.seq + 1} → v${first.seq}  ${shortHash(first.root)}`);
    return 0;
  }

  if (action === 'drop') {
    const victim = findCommit(repo, opts.positional[1] ?? '');
    if (!victim) return 1;
    const next = chain.commits.find((c) => c.parent === victim.root);
    if (next) next.parent = victim.parent;
    // 支指针若指在被删条目上，随 parent 链回退一格
    for (const [b, r] of Object.entries(chain.branches)) {
      if (r === victim.root) chain.branches[b] = victim.parent;
    }
    chain.commits = chain.commits.filter((c) => c !== victim);
    renumber(chain);
    dirty(repo);
    console.log(`dropped: v${victim.seq}  ${shortHash(victim.root)}  ${victim.message}`);
    return 0;
  }

  if (action === 'reset') {
    const target = findCommit(repo, opts.positional[1] ?? '');
    if (!target) return 1;
    chain.branches[chain.current] = target.root;
    chain.commits = chain.commits.filter((c) => c.seq <= target.seq);
    renumber(chain);
    dirty(repo);
    console.log(`reset:   ${chain.name}@${chain.current} → v${target.seq}  ${shortHash(target.root)}  (later revisions dropped)`);
    return 0;
  }

  console.error(`error: unknown history action "${action}"`);
  return 1;
}
