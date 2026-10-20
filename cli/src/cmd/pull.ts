import { defaultDataDir, loadState } from '../state.js';
import { fetchRemoteDoc } from '../client.js';
import { fetchInstanceChain } from '../sync.js';
import { dirtyGuardMessage, isDirty, openPool, resolveRepo, saveChain, writeWorkingFile } from '../practice.js';
import { shortHash } from '../render.js';

export interface PullOpts {
  dataDir?: string;
  /** 定位覆盖：实例文件夹（--dir）；缺省=cwd 向上找 .practi */
  dir?: string;
}

/**
 * practi pull：把当前实例的远端更新对账进本地（git pull 同构）：
 * - hub 链上本地缺失的修订逐个拉入 .practi 池并补进本地链
 * - 远端支头前进且为本地链的延伸 → 支指针快进，工作文件回写到新头
 * - 远端头不在本地链（分叉）→ 报错（本地有未推修订时提示 --force 对账）
 * 实例须已推送过（owner 就位）——本地新实例没有远端可拉。工作文件有未提交改动时拒拉。
 */
export async function runPull(opts: PullOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const repo = resolveRepo({ dir: opts.dir, verb: 'pull' });
  if (repo === null) return 1;
  const chain = repo.chain;
  if (chain.owner === null) {
    console.error(`error: practice "${chain.name}" has never been pushed — nothing to pull from`);
    return 1;
  }
  if (isDirty(repo)) {
    console.error(`error: ${dirtyGuardMessage(repo)}`);
    return 1;
  }
  openPool(repo); // 池标记就绪检查（practice.yaml/nodes 缺失即在此报）

  const view = await fetchInstanceChain(dataDir, state.remote.url, chain.owner, chain.name, chain.current);

  // 补齐：hub 链上本地缺的对象与链条目
  const knownRoots = new Set(chain.commits.map((c) => c.root));
  let fetched = 0;
  let added = 0;
  for (const rev of view.revisions) {
    if (rev.missing) continue;
    if (!knownRoots.has(rev.root_hash)) {
      try {
        await fetchRemoteDoc(dataDir, repo.poolDir, state.remote.url, chain.owner, chain.name, rev.root_hash);
        fetched++;
      } catch (e) {
        console.error(`pull failed: ${(e as Error).message}`);
        return 1;
      }
      chain.commits.push({
        seq: rev.seq,
        root: rev.root_hash,
        parent: null,
        message: `pulled from ${chain.owner}/${chain.name}`,
        pushedAt: new Date().toISOString(),
      });
      added++;
    }
  }
  if (added > 0) {
    // seq 按 hub 链序重排（视图 tip 在前 → 反转即链序），parent 按相邻血统重挂
    const order = new Map(view.revisions.slice().reverse().map((r, i) => [r.root_hash, i + 1]));
    for (const c of chain.commits) {
      if (order.has(c.root)) c.seq = order.get(c.root)!;
    }
    chain.commits.sort((a, b) => a.seq - b.seq);
    const hubSeq = view.revisions.map((r) => r.root_hash);
    const parentOf = new Map<string, string | null>();
    hubSeq.forEach((root, i) => parentOf.set(root, i > 0 ? hubSeq[i - 1] : null));
    for (const c of chain.commits) {
      if (parentOf.has(c.root)) c.parent = parentOf.get(c.root)!;
    }
  }

  const hubHead = view.head;
  const localHead = chain.branches[chain.current] ?? null;
  const hubHeadKnown = hubHead !== null && (knownRoots.has(hubHead) || added > 0);

  if (localHead !== null && hubHead !== null && !hubHeadKnown) {
    const localUnpushed = chain.commits.some((c) => c.pushedAt === undefined);
    saveChain(repo);
    console.error(
      `pull: the hub's ${chain.name}@${chain.current} is at ${shortHash(hubHead)}, not in your local chain` +
        (localUnpushed
          ? ' — and you have unpushed local revisions. Reconcile by hand (history reset), then `practi push --force`'
          : ' — consider `practi push --force` to overwrite the hub')
    );
    return 1;
  }

  if (hubHead !== null && hubHead !== localHead) {
    // 走到这里 hubHead 必在本地链（不在已在上面分叉退出）→ 支指针快进
    chain.branches[chain.current] = hubHead;
  }

  saveChain(repo);
  if (fetched === 0 && added === 0 && hubHead === localHead) {
    console.log('up to date — nothing new to pull');
    return 0;
  }
  const head = chain.branches[chain.current];
  if (head !== null) writeWorkingFile(repo, head);
  console.log(
    `pulled:  ${fetched} document(s), ${added} chain revision(s) — ${chain.name}@${chain.current} → ${shortHash(head ?? '')}  (working file updated)`
  );
  return 0;
}
