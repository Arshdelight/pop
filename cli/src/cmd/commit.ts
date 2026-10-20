import fs from 'node:fs';
import { createFromDoc, loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { appendChainCommit, chainHead, openPool, resolveRepo, saveChain, type ChainCommit, type Repo } from '../practice.js';
import { printQualityHints } from '../quality.js';
import { shortHash } from '../render.js';
import { subtreeFiles } from '../workspace.js';

export interface CommitOpts {
  positional: string[];
  message?: string;
  /** 改支头：工作文件的当前内容替换 head（git commit --amend 同款） */
  amend?: boolean;
  dir?: string;
}

/**
 * practi commit [-m <msg>] [--amend]：快照工作文件 → 当前支新修订（本地，不碰网络）。
 * - 工作文件与 head 相同 → nothing to commit；说明缺省用 pop 名
 * - --amend：替换支头而非追加（git 同款）；内容相同只给 -m = 改说明
 * - 已推送的链被 amend 后与 hub 分叉，push 时对账报错，--force 覆盖
 */
export async function runCommit(opts: CommitOpts): Promise<number> {
  const repo = resolveRepo({ dir: opts.dir, verb: 'commit' });
  if (repo === null) return 1;
  const chain = repo.chain;

  let text: string;
  try {
    text = fs.readFileSync(repo.filePath, 'utf8');
  } catch {
    console.error(
      `error: working file ${chain.name}.json not found in ${repo.dir} — write it first` +
        (chainHead(chain) ? ` or restore it with \`practi export ${chainHead(chain)!.slice(7, 19)}\`` : '')
    );
    return 1;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`error [E_JSON]: ${(e as Error).message}`);
    return 1;
  }

  const ws = openPool(repo);
  let root: string;
  try {
    root = createFromDoc(ws, doc as Record<string, unknown>).root;
  } catch (e) {
    console.error(`error [E_SCHEMA]: ${(e as Error).message}`);
    return 1;
  }

  if (opts.amend === true) {
    const head = chainHead(chain);
    const tip = chain.commits.find((c) => c.root === head);
    if (head === null || !tip) {
      console.error('error: the practice has no revisions to amend');
      return 1;
    }
    const oldRoot = tip.root;
    tip.root = root;
    if (opts.message !== undefined) tip.message = opts.message;
    delete tip.pushedAt;
    if (oldRoot !== root) {
      // 指向旧头的其它支随 parent 链落到存活祖先；当前支头恒等式单独落新 root
      for (const [b, r] of Object.entries(chain.branches)) {
        if (r === oldRoot && b !== chain.current) chain.branches[b] = tip.parent;
      }
      chain.branches[chain.current] = root;
    }
    saveChain(repo);
    console.log(`amended: ${chain.name}@${chain.current} v${tip.seq}  ${shortHash(root)}  ${tip.message}`);
    printQualityHints(loadWorkspace(repo.poolDir), root);
    return 0;
  }

  if (root === chainHead(chain)) {
    console.log(`nothing to commit — working file matches ${chain.name}@${chain.current} (${shortHash(root)})`);
    return 0;
  }
  const message = opts.message ?? (typeof (doc as { name?: unknown }).name === 'string' ? (doc as { name: string }).name : '');
  const commit = appendChainCommit(repo, root, message);
  // 子树门禁：E_* 级问题拦下（链已回滚——appendChainCommit 后重排，见下）
  const loaded = loadWorkspace(repo.poolDir);
  const mine = subtreeFiles(loaded, root);
  const issues = validateWorkspace(loaded).filter((i) => mine.has(i.file));
  if (issues.length > 0) {
    rollbackCommit(repo, commit);
    for (const i of issues) console.error(`  ${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
    console.error('error:  not committed — fix the document and try again');
    return 1;
  }
  console.log(`committed: ${chain.name}@${chain.current} v${commit.seq}  ${shortHash(root)}  ${commit.message}`);
  printQualityHints(loaded, root);
  return 0;
}

/** 链回滚一格（门禁拦截时把刚追加的提交撤掉） */
function rollbackCommit(repo: Repo, commit: ChainCommit): void {
  const chain = repo.chain;
  chain.commits = chain.commits.filter((c) => c !== commit);
  chain.branches[chain.current] = commit.parent;
  saveChain(repo);
}
