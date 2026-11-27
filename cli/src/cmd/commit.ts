import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFromDoc, loadWorkspace, validateWorkspace, type Workspace } from '@arshdelight/pop-sdk';
import { appendChainCommit, chainHead, openPool, resolveRepo, saveChain, type ChainCommit, type Repo } from '../practice.js';
import { printQualityHints } from '../quality.js';
import { shortHash } from '../render.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { authedFetch, fetchDirectInstance, HubApiError, hubErrorMessage, normalizeHashRef, type DirectInstanceView } from '../client.js';
import { missingBlobsOf, stripAttachmentUrls } from './push.js';
import { parseCloneRef } from './clone.js';
import { subtreeFiles } from '../workspace.js';

export interface CommitOpts {
  positional: string[];
  message?: string;
  /** 改支头：工作文件的当前内容替换 head（git commit --amend 同款） */
  amend?: boolean;
  /** 远程模式：--file <path|->（必给，index.ts 把关）；- 读 stdin */
  file?: string;
  /** 远程模式：--base <hash|vN> 声明这份文档基于哪个头（先在本地比对） */
  base?: string;
  /** 远程模式：--force 用这一份文档替换整条链（之前的版本不可达） */
  force?: boolean;
  dir?: string;
  /** 配置家（远程模式读凭据与 remote）；本地模式不用 */
  dataDir?: string;
}

/**
 * practi commit [-m <msg>] [--amend]：快照工作文件 → 当前支新修订（本地，不碰网络）。
 * - 工作文件与 head 相同 → nothing to commit；说明缺省用 pop 名
 * - --amend：替换支头而非追加（git 同款）；内容相同只给 -m = 改说明
 * - 已推送的链被 amend 后与 hub 分叉，push 时对账报错，--force 覆盖
 * 位置参数带 `<owner>/<name>`（含 `@branch`）= 不经本地文件夹直接写 hub（--file 给文档）
 */
export async function runCommit(opts: CommitOpts): Promise<number> {
  if (opts.positional.length > 0 && opts.positional[0].includes('/')) {
    return commitRemote(opts);
  }
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

const DIRECT_USAGE =
  'usage: practi commit <owner>/<name>[@branch] --file <path|-> [-m <msg>] [--base <hash|vN>] [--amend] [--force]   |   practi commit [-m <msg>] [--amend]   (local)';

/** 读文档文件（- 读 stdin）+ 临时 workspace 跑与本地 commit 同一套校验。失败打错返回
 *  null（临时目录就地删掉）。成功返回根哈希、workspace（成功后打 W 提示用）与剥好
 *  附件 url 的文档（hub 不收 url，与本地 push 同款）。E_BLOB_MISSING 例外：远程模式
 *  下附件字节本就不在本地，交给 hub 判（400 缺什么补什么）。
 *  commit <ref> --file 与 new <name> --file 共用——两处必须是同一套门。 */
export function stageRemoteDoc(
  file: string
): { root: string; ws: Workspace; document: Record<string, unknown>; dispose(): void } | null {
  let text: string;
  try {
    text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`error: cannot read ${file === '-' ? 'stdin' : file} (${(e as Error).message})`);
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    console.error(`error [E_JSON]: ${(e as Error).message}`);
    return null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'practi-direct-'));
  try {
    const ws = loadWorkspace(tmp);
    let root: string;
    try {
      root = createFromDoc(ws, doc).root;
    } catch (e) {
      console.error(`error [E_SCHEMA]: ${(e as Error).message}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return null;
    }
    // createFromDoc 只落盘不回填内存索引——与本地 commit 同款重载后再校验
    const loaded = loadWorkspace(tmp);
    const mine = subtreeFiles(loaded, root);
    const issues = validateWorkspace(loaded).filter((i) => mine.has(i.file) && i.code !== 'E_BLOB_MISSING');
    if (issues.length > 0) {
      for (const i of issues) console.error(`  ${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
      console.error('error:  not committed — fix the document and try again');
      fs.rmSync(tmp, { recursive: true, force: true });
      return null;
    }
    return {
      root,
      ws: loaded,
      document: stripAttachmentUrls(doc),
      dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * practi commit <owner>/<name>[@branch] --file <path|->：不经本地文件夹直接写 hub。
 * 追加在支头之后（--base 声明父版本——force 端点不收 parent_hash，与支头不符在本地
 * 先拦，零请求退出）；--amend 经 force 端点替换支头那条（更早的版本保留，指着旧头
 * 的其他支落到旧头的 parent）；--force 用这一份文档替换整条链（之前的版本不可达）。
 */
async function commitRemote(opts: CommitOpts): Promise<number> {
  if (opts.amend === true && opts.force === true) {
    console.error('error: --amend and --force are mutually exclusive — amend replaces the head revision, --force replaces the whole chain');
    console.error(DIRECT_USAGE);
    return 1;
  }
  const parsed = parseCloneRef(opts.positional[0]);
  if (!parsed || parsed.owner === undefined) {
    console.error('error: a hub practice needs its owner — `practi commit <owner>/<name>[@branch] --file <path|->` (a bare name is ambiguous with a local commit)');
    console.error(DIRECT_USAGE);
    return 1;
  }
  if (opts.file === undefined) {
    console.error('error: commit with an address needs the document — pass --file <path|-> (- reads stdin)');
    console.error(DIRECT_USAGE);
    return 1;
  }
  const { owner, name } = parsed;
  const address = `${owner}/${name}`;
  const dataDir = opts.dataDir ?? defaultDataDir();
  const remote = remoteUrl(dataDir);
  const base = `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const staged = stageRemoteDoc(opts.file);
  if (staged === null) return 1;
  const { root, ws, document, dispose } = staged;
  try {
    const message = opts.message ?? (typeof document.name === 'string' ? document.name : '');

    // 实例视图；支不存在先建支再取（与本地 push 首推自动建支一致）
    let view: DirectInstanceView;
    try {
      view = await fetchDirectInstance(dataDir, remote, owner, name, parsed.branch);
    } catch (e) {
      if (e instanceof HubApiError && e.code === 'E_INSTANCE_NOT_FOUND') {
        console.error(`error: ${address} does not exist on the hub yet — create it with \`practi new ${name} --file <path|->\``);
        return 1;
      }
      if (!(e instanceof HubApiError && e.code === 'E_BRANCH_NOT_FOUND') || parsed.branch === undefined) throw e;
      const mk = await authedFetch(dataDir, remote, `${base}/branches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: parsed.branch }),
      });
      if (!mk.ok) {
        const mkBody = (await mk.json().catch(() => ({}))) as Record<string, unknown>;
        console.error(`error: creating branch "${parsed.branch}" on the hub — ${hubErrorMessage(mk.status, mkBody)}`);
        return 1;
      }
      view = await fetchDirectInstance(dataDir, remote, owner, name, parsed.branch);
    }
    const branch = view.branch;
    const ref = `${address}@${branch}`;
    const head = view.branch_head_hash;
    const headRev = head !== null ? view.revisions.find((r) => r.root_hash === head) ?? null : null;

    // --base 解析（vN 按 seq；哈希全形或前缀）；找不到零写请求退出
    let baseRoot: string | null = null;
    if (opts.base !== undefined) {
      const vm = /^v(\d+)$/i.exec(opts.base.trim());
      let rev: DirectInstanceView['revisions'][number] | null;
      if (vm) {
        const seq = Number(vm[1]);
        rev = view.revisions.find((r) => r.seq === seq) ?? null;
        if (rev === null) {
          console.error(`error: --base v${seq} — no revision v${seq} on ${ref} (this branch has ${view.revisions.length})`);
          return 1;
        }
      } else {
        const full = normalizeHashRef(opts.base);
        if (full !== null) {
          rev = view.revisions.find((r) => r.root_hash === full) ?? null;
        } else {
          const hex = opts.base.replace(/^sha256:/i, '').toLowerCase();
          const hits = view.revisions.filter((r) => r.root_hash.startsWith(`sha256:${hex}`));
          if (hits.length > 1) {
            console.error(`error: --base ${opts.base} is ambiguous — ${hits.length} revisions share this prefix (give more characters, or use vN)`);
            return 1;
          }
          rev = hits[0] ?? null;
        }
        if (rev === null) {
          console.error(`error: --base ${opts.base} is not in the history of ${ref}`);
          return 1;
        }
      }
      baseRoot = rev.root_hash;
      // 本地先比一次：--base 与当前支头不符直接拒绝，不发任何写请求
      if (baseRoot !== head) {
        console.error(
          `error: --base ${opts.base} resolves to v${rev.seq} (${shortHash(baseRoot)}) but the head of ${ref} is ` +
            (head === null ? 'empty' : `v${headRev?.seq} (${shortHash(head)})`) +
            ` — read the latest with \`practi show ${ref} --doc\` and redo your edit on it`
        );
        return 1;
      }
    }

    // 文档的根与支头相同 → nothing to commit，零写请求
    if (root === head) {
      console.log(`nothing to commit — the document matches ${ref} v${headRev?.seq ?? 0} (${shortHash(root)})`);
      return 0;
    }

    // hub 写应答的统一出口（409 → 先 show 再重做；E_BLOB_MISSING → 列缺失哈希给 blob add）
    const reportWriteError = (status: number, body: Record<string, unknown>): void => {
      if (status === 409 && body.code === 'E_HEAD_MOVED') {
        console.error(
          `error: the head of ${ref} moved after this document was prepared (HTTP 409 E_HEAD_MOVED)` +
            ` — read the latest with \`practi show ${ref} --doc\` and redo your edit on it`
        );
        return;
      }
      const missing = missingBlobsOf(body);
      if (missing !== null) {
        console.error(`error: the hub is missing attachment bytes for this document — upload each one with \`practi blob add ${address} <file-or-url>\`, then commit again:`);
        for (const h of missing) console.error(`  ${h}`);
        return;
      }
      console.error(`error: ${hubErrorMessage(status, body)}`);
    };

    if (opts.amend === true) {
      if (head === null || headRev === null) {
        console.error(`error: ${ref} has no revisions to amend`);
        return 1;
      }
      const newMessage = opts.message ?? headRev.message;
      // 新链 = 目标支自己的旧版本（支头除外）+ 其他支的历史，按 root 去重；指着旧头的
      // 其他支落到旧头的 parent。documents 只带新文档——其余的 hub 都已有
      const commits: { root_hash: string; parent_hash: string | null; message: string }[] = [
        { root_hash: root, parent_hash: headRev.parent_hash, message: newMessage },
      ];
      const seen = new Set<string>([head]);
      const addHistory = (revs: DirectInstanceView['revisions']): void => {
        for (const r of revs) {
          if (seen.has(r.root_hash)) continue;
          seen.add(r.root_hash);
          commits.push({ root_hash: r.root_hash, parent_hash: r.parent_hash, message: r.message });
        }
      };
      addHistory(view.revisions);
      const branchTable: Record<string, string | null> = { [branch]: root };
      for (const b of view.branches) {
        if (b.name === branch) continue;
        const bv = await fetchDirectInstance(dataDir, remote, owner, name, b.name);
        addHistory(bv.revisions);
        branchTable[b.name] = b.head_hash === head ? headRev.parent_hash : b.head_hash;
      }
      // 复查支头：准备期间被别人动过就中止（防止替换掉别人刚推的版本），零写请求
      const recheck = await fetchDirectInstance(dataDir, remote, owner, name, branch);
      if (recheck.branch_head_hash !== head) {
        console.error(
          `error: the head of ${ref} moved while this document was being prepared (now ` +
            (recheck.branch_head_hash === null ? 'empty' : shortHash(recheck.branch_head_hash)) +
            `) — re-read it with \`practi show ${ref} --doc\` and try again`
        );
        return 1;
      }
      const res = await authedFetch(dataDir, remote, `${base}/branches/${encodeURIComponent(branch)}/revisions?force=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commits, documents: [{ root_hash: root, document }], branches: branchTable }),
      });
      const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        reportWriteError(res.status, resBody);
        return 1;
      }
      console.log(`amended: ${ref} v${headRev.seq}  ${shortHash(root)}  ${newMessage}`);
      printQualityHints(ws, root);
      return 0;
    }

    if (opts.force === true) {
      // 只留新版：commits 一条（parent=null），支表只留目标支
      const res = await authedFetch(dataDir, remote, `${base}/branches/${encodeURIComponent(branch)}/revisions?force=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commits: [{ root_hash: root, parent_hash: null, message }],
          documents: [{ root_hash: root, document }],
          branches: { [branch]: root },
        }),
      });
      const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        reportWriteError(res.status, resBody);
        return 1;
      }
      const dropped = typeof resBody.dropped === 'number' ? resBody.dropped : 0;
      console.log(
        `forced:  ${ref} v1  ${shortHash(root)}  ${message}` +
          (head !== null ? `  (hub dropped ${dropped} unreachable revision(s) — the previous versions are no longer reachable)` : '')
      );
      printQualityHints(ws, root);
      return 0;
    }

    // 默认（追加）：只有给了 --base 才带 parent_hash
    const body: Record<string, unknown> = { document, message };
    if (baseRoot !== null) body.parent_hash = baseRoot;
    const res = await authedFetch(dataDir, remote, `${base}/branches/${encodeURIComponent(branch)}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      reportWriteError(res.status, resBody);
      return 1;
    }
    const seq = typeof resBody.seq === 'number' ? resBody.seq : (headRev?.seq ?? 0) + 1;
    console.log(`pushed:  ${ref} v${seq}  ${shortHash(root)}  ${message}`);
    printQualityHints(ws, root);
    return 0;
  } finally {
    dispose();
  }
}
