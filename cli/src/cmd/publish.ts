import fs from 'node:fs';
import path from 'node:path';
import { createFromDoc, exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { appendChainCommit, chainHead, createPractice, registryNameTaken, resolvePractice } from '../practice.js';
import { pushRepo, stripAttachmentUrls } from './push.js';
import { collectUnreachable, gcRootSet } from './edit.js';
import { nodeFilePath } from '@arshdelight/pop-sdk';
import { shortHash } from '../render.js';

export interface PublishOpts {
  dataDir?: string;
  positional: string[];
  /** 目标实例（账本名）；cwd 在实例目录里时可省 */
  to?: string;
  /** 目标为独立目录实例时的定位覆盖 */
  dir?: string;
  /** 提交说明（缺省用 pop 名） */
  message?: string;
  /** 保留 pops 区原稿（默认移除——移入实例后游离副本无存在意义） */
  keep?: boolean;
}

/**
 * practi publish <pop-ref | file.json> [--to <practice>] [-m <msg>] [--keep]：
 * 一篇 pop 成为实例的新修订并推 hub（一条命令，git commit+push 同构）。
 * - <pop-ref>：工作目录 pops 区的哈希/前缀；<file.json>：任意目录的 pop 文件
 *   （不经 pops 直达实例——pop 编辑器与管理器的合流点）。
 * - 默认移除 pops 区原稿（移入实例后游离副本无存在意义）；--keep 保留。
 * - 目标实例在 hub 不存在则随之诞生（首推创建）。
 */
export async function runPublish(opts: PublishOpts): Promise<number> {
  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: practi publish <pop-ref | file.json> [--to <practice>] [-m <msg>] [--keep]');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  // publish 是合流点：--to 新名字=就地建实例（push 时 hub 诞生）；已有实例按定位规则解析
  let repo: ReturnType<typeof resolvePractice>;
  if (opts.to !== undefined && !registryNameTaken(dataDir, opts.to)) {
    repo = createPractice(dataDir, opts.to);
  } else {
    repo = resolvePractice({ dataDir, explicitDir: opts.dir, explicitName: opts.to, verb: 'publish' });
  }
  if (repo === null) return 1;

  const poolDir = repo.kind === 'directory' ? repo.dataDir : dataDir;
  const poolWs = openWorkspace(poolDir);

  // 1. 取得文档（pops 区引用 或 任意路径文件）
  let docObj: unknown;
  let fromPops: string | null = null;
  let popName = '';
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
    try {
      docObj = JSON.parse(fs.readFileSync(ref, 'utf8'));
    } catch (e) {
      console.error(`error [E_JSON]: ${(e as Error).message}`);
      return 1;
    }
    popName = typeof (docObj as { name?: unknown }).name === 'string' ? (docObj as { name: string }).name : path.basename(ref);
  } else {
    const ws = openWorkspace(dataDir);
    let root: string;
    try {
      root = resolveNodeRef(ws, ref);
    } catch (e) {
      console.error(`error: ${ref} is neither a file nor a pop in the workspace — ${(e as Error).message}`);
      return 1;
    }
    if (!state.direct.includes(root)) {
      console.error(`error: ${shortHash(root)} is not one of your pops (publish moves a pop into a practice)`);
      return 1;
    }
    fromPops = root;
    const node = ws.nodes.get(root);
    if (!node) {
      console.error(`error: node not found: ${root}`);
      return 1;
    }
    docObj = stripAttachmentUrls(exportSubtree(node, ws.nodes));
    popName = node.name;
  }

  // 2. 入实例节点池（registry 共享池=同哈希零复制；directory 独立池=内容复制）
  let root: string;
  try {
    const created = createFromDoc(poolWs, docObj as Record<string, unknown>);
    root = created.root;
  } catch (e) {
    console.error(`error [E_SCHEMA]: ${(e as Error).message}`);
    return 1;
  }

  // 3. 链上追加提交（parent=当前支头）
  if (chainHead(repo.chain) === root) {
    console.log(`up to date — ${repo.chain.name}@${repo.chain.current} already ends at ${shortHash(root)}`);
    return 0;
  }
  const message = opts.message ?? popName;
  const commit = appendChainCommit(repo, root, message);

  // 4. 推 hub（首次创建实例；FF 逐条；分叉报错）
  if (repo.chain.owner === null) {
    console.log(`note:    practice "${repo.chain.name}" is new to the hub — it will be created by this push`);
  }
  const pushed = await pushRepo(repo, { dataDir, remote: state.remote.url, verbose: false });
  if (pushed !== 0) {
    console.error('publish failed at the push step — the local revision is kept, fix the remote and `practi push` again');
    return 1;
  }

  // 5. 移除 pops 区原稿（默认；--keep 保留）——链根保护下节点不被 gc，
  //    移除的只是「登记」：这篇 pop 现在以实例修订的身份存在
  if (fromPops !== null && opts.keep !== true) {
    const live = loadState(dataDir);
    live.direct = live.direct.filter((h) => h !== fromPops);
    saveState(dataDir, live);
    const ws = openWorkspace(dataDir);
    const dead = collectUnreachable(ws, gcRootSet(dataDir, live.direct));
    for (const h of dead) fs.unlinkSync(nodeFilePath(dataDir, h));
    console.log(`removed from pops: ${shortHash(fromPops)}  (now living as ${repo.chain.name}@${repo.chain.current} v${commit.seq}; --keep would have kept it)`);
  } else if (fromPops !== null) {
    console.log('kept:    the pop stays in your workspace (--keep)');
  }
  console.log(`published: ${popName}  →  ${repo.chain.name}@${repo.chain.current}  v${commit.seq}  ${shortHash(root)}`);
  return 0;
}
