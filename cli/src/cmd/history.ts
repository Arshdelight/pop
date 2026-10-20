import {
  chainHead,
  resolveRepo,
  saveChain,
  workingRoot,
  type ChainCommit,
  type Repo,
} from '../practice.js';
import { shortHash } from '../render.js';

export interface HistoryOpts {
  positional: string[];
  dir?: string;
  message?: string;
}

/** 重排 seq 为 1..n 连续（链重写后统一收口） */
function renumber(chain: Repo['chain']): void {
  chain.commits.sort((a, b) => a.seq - b.seq);
  chain.commits.forEach((c, i) => (c.seq = i + 1));
}

/** 重写前的 parent 快照——悬空支指针要沿「重写前」的 parent 链回走到存活祖先 */
function parentsSnapshot(chain: Repo['chain']): Map<string, string | null> {
  return new Map(chain.commits.map((c) => [c.root, c.parent] as const));
}

/** 重写收口：清全链 pushedAt（对账靠 push --force），悬空支指针沿重写前 parent 修到存活祖先 */
function dirty(repo: Repo, before?: Map<string, string | null>): void {
  const alive = new Set(repo.chain.commits.map((c) => c.root));
  rewriteSettle(repo, alive, before ?? parentsSnapshot(repo.chain));
}

/** 支指针落在了被重写丢弃的 root 上 → 沿重写前 parent 链回走到存活祖先，走不到=空支 */
function rewriteSettle(repo: Repo, alive: Set<string>, oldParents: Map<string, string | null>): void {
  for (const [b, r] of Object.entries(repo.chain.branches)) {
    if (r !== null && alive.has(r)) continue;
    let moved: string | null = null;
    const seen = new Set<string>();
    let cur = r;
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

/** head 的 root 是否因本次重写变动（变动则提示工作文件的处置） */
function headChanged(chain: Repo['chain'], beforeHead: string | null): boolean {
  return chainHead(chain) !== beforeHead;
}

/**
 * 重写后收尾（git reset 的「不动工作树」语义）：链是权威，工作文件原样保留——
 * 它相对新头成了未提交改动，由使用者决定 commit 留下还是 export 丢弃。
 */
function moveHeadFollowup(repo: Repo, beforeHead: string | null): void {
  if (!headChanged(repo.chain, beforeHead)) return;
  const head = chainHead(repo.chain);
  const fileRoot = workingRoot(repo);
  if (head !== null && fileRoot !== null && fileRoot !== head) {
    const hint = `practi export ${head.slice(7, 19)} -o ${repo.chain.name}.json`;
    console.log(
      `note:    the working file still holds the pre-rewrite content — ` +
        `commit it to keep, or ${hint} to discard`
    );
  }
}

/**
 * practi history — 实例提交链的本地重写（push 时与 hub 对账）：
 *   history reword <seq> -m <msg>   改任意条提交说明（root 不变）
 *   history squash <seq>            合并 seq 与 seq+1（内容取 seq+1，说明拼接）
 *   history drop <seq>              删除中间某条提交（其后 parent 接前）
 *   history reset <seq>             支头回退到 seq（其后提交丢弃，工作文件回写）
 * 支头内容替换走 `practi commit --amend`。已推送的链同样可改——push 时分叉报错，
 * --force 用本地链覆盖（hub 清不可达对象）。
 */
export async function runHistory(opts: HistoryOpts): Promise<number> {
  const action = opts.positional[0];
  if (!action) {
    console.error('usage: practi history reword <seq> -m <msg> | squash <seq> | drop <seq> | reset <seq>');
    return 1;
  }
  const repo = resolveRepo({ dir: opts.dir, verb: 'history' });
  if (repo === null) return 1;
  const chain = repo.chain;

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
    const beforeHead = chainHead(chain);
    const before = parentsSnapshot(chain);
    // 内容取后者的 root（squash = 两次编辑折叠成一次落定），parent 保持 first 的原 parent
    first.root = second.root;
    first.message = `${first.message}\n${second.message}`;
    chain.commits = chain.commits.filter((c) => c !== second);
    for (const [b, r] of Object.entries(chain.branches)) {
      if (r === second.root) chain.branches[b] = first.root;
    }
    renumber(chain);
    dirty(repo, before);
    moveHeadFollowup(repo, beforeHead);
    console.log(`squashed: v${first.seq}+v${first.seq + 1} → v${first.seq}  ${shortHash(first.root)}`);
    return 0;
  }

  if (action === 'drop') {
    const victim = findCommit(repo, opts.positional[1] ?? '');
    if (!victim) return 1;
    const beforeHead = chainHead(chain);
    const before = parentsSnapshot(chain);
    const next = chain.commits.find((c) => c.parent === victim.root);
    if (next) next.parent = victim.parent;
    for (const [b, r] of Object.entries(chain.branches)) {
      if (r === victim.root) chain.branches[b] = victim.parent;
    }
    chain.commits = chain.commits.filter((c) => c !== victim);
    renumber(chain);
    dirty(repo, before);
    moveHeadFollowup(repo, beforeHead);
    console.log(`dropped: v${victim.seq}  ${shortHash(victim.root)}  ${victim.message}`);
    return 0;
  }

  if (action === 'reset') {
    const target = findCommit(repo, opts.positional[1] ?? '');
    if (!target) return 1;
    const beforeHead = chainHead(chain);
    const before = parentsSnapshot(chain);
    chain.branches[chain.current] = target.root;
    chain.commits = chain.commits.filter((c) => c.seq <= target.seq);
    renumber(chain);
    dirty(repo, before);
    moveHeadFollowup(repo, beforeHead);
    console.log(`reset:   ${chain.name}@${chain.current} → v${target.seq}  ${shortHash(target.root)}  (later revisions dropped)`);
    return 0;
  }

  console.error(`error: unknown history action "${action}"`);
  return 1;
}

function findCommit(repo: Repo, seqStr: string): ChainCommit | null {
  const seq = Number(seqStr);
  const c = repo.chain.commits.find((x) => x.seq === seq);
  if (!c) console.error(`error: no commit v${seqStr} in ${repo.chain.name} (practi log)`);
  return c ?? null;
}
