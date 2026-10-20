import fs from 'node:fs';
import path from 'node:path';
import { createFromDoc, initWorkspace, loadWorkspace, parseDocument, exportSubtree, type Workspace } from '@arshdelight/pop-sdk';

/**
 * 实例 = 自包含文件夹（2026-10-20 文件夹式终稿，类 .git）：
 *   <dir>/<name>.json   工作文件——pop 本体，任何编辑器直接改
 *   <dir>/.practi/      仓库内部——practice.yaml + nodes/ + blobs/（内容寻址池）
 *                       + chain.json（提交链+支指针，与 hub revisions 同构）
 * 定位=cwd 向上找 .practi/chain.json（或 --dir 显式）；一切本地命令跑在实例内。
 * 链上 head 变动的命令（switch/merge/reset/pull/clone）回写工作文件；
 * 工作文件与 head 不同（dirty）时这些命令拒切——先 commit。
 */

export interface ChainCommit {
  /** 实例内登记序号（1 起，链顺序） */
  seq: number;
  /** 修订根哈希（sha256:...，内容寻址身份） */
  root: string;
  /** 父修订根；首提交为 null */
  parent: string | null;
  message: string;
  /** 已同步 hub 的盖戳 */
  pushedAt?: string;
}

export interface ChainFile {
  schema: 1;
  name: string;
  /** hub 身份（首次 push 成功后回填；未推=null） */
  owner: string | null;
  /** 当前支 */
  current: string;
  /** 支指针表：支名→root（git 的 refs） */
  branches: Record<string, string | null>;
  commits: ChainCommit[];
}

export interface Repo {
  /** 实例文件夹（工作文件所在地） */
  dir: string;
  chain: ChainFile;
  chainPath: string;
  /** 工作文件（<name>.json） */
  filePath: string;
  /** 仓库内部目录（.practi，节点池所在地） */
  poolDir: string;
}

const PRACTI_DIR = '.practi';

function isHash(v: unknown): v is string {
  return typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
}

export function practiDirFor(dir: string): string {
  return path.join(dir, PRACTI_DIR);
}

export function chainPathFor(dir: string): string {
  return path.join(dir, PRACTI_DIR, 'chain.json');
}

/** 工作文件路径（约定 <name>.json；name 是链的身份，改名=整文件夹改名） */
export function workingFileFor(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

/** 读链文件，坏文件/坏条目降级跳过 */
export function loadChain(file: string): ChainFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (rec.schema !== 1 || typeof rec.name !== 'string') return null;
    const chain: ChainFile = {
      schema: 1,
      name: rec.name,
      owner: typeof rec.owner === 'string' ? rec.owner : null,
      current: typeof rec.current === 'string' ? rec.current : 'main',
      branches: {},
      commits: [],
    };
    if (rec.branches && typeof rec.branches === 'object') {
      for (const [k, v] of Object.entries(rec.branches as Record<string, unknown>)) {
        if (v === null || isHash(v)) chain.branches[k] = v;
      }
    }
    if (!Array.isArray(rec.commits)) return chain;
    const seen = new Set<string>();
    for (const item of rec.commits as Record<string, unknown>[]) {
      if (!isHash(item.root) || typeof item.seq !== 'number') continue;
      if (item.parent !== null && !isHash(item.parent)) continue;
      if (typeof item.message !== 'string') continue;
      if (seen.has(item.root)) continue; // 链上同 root 恰一行（spec §9.1）
      seen.add(item.root);
      const c: ChainCommit = {
        seq: item.seq,
        root: item.root,
        parent: item.parent ?? null,
        message: item.message,
      };
      if (typeof item.pushedAt === 'string') c.pushedAt = item.pushedAt;
      chain.commits.push(c);
    }
    chain.commits.sort((a, b) => a.seq - b.seq);
    return chain;
  } catch {
    return null;
  }
}

export function saveChain(repo: Repo): void {
  fs.mkdirSync(path.dirname(repo.chainPath), { recursive: true });
  fs.writeFileSync(repo.chainPath, JSON.stringify(repo.chain, null, 2) + '\n', 'utf8');
}

/** 当前支头（空仓库=null） */
export function chainHead(chain: ChainFile, branch?: string): string | null {
  return chain.branches[branch ?? chain.current] ?? null;
}

/** 目录是不是一个实例文件夹（.practi/chain.json 在） */
export function isRepoDir(dir: string): boolean {
  return fs.existsSync(chainPathFor(dir));
}

/** cwd（或其祖先）是否坐在一个实例文件夹里 */
export function findRepoFromCwd(cwd: string): Repo | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (isRepoDir(dir)) {
      const chain = loadChain(chainPathFor(dir));
      if (chain) return { dir, chain, chainPath: chainPathFor(dir), filePath: workingFileFor(dir, chain.name), poolDir: practiDirFor(dir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 定位实例（--dir 显式 或 cwd）；定位失败打印错误并返回 null */
export function resolveRepo(opts: { dir?: string; cwd?: string; verb?: string }): Repo | null {
  const fail = (msg: string): null => {
    console.error(`error: ${msg}`);
    return null;
  };
  if (opts.dir) {
    const dir = path.resolve(opts.dir);
    if (!isRepoDir(dir)) return fail(`${dir} is not a practice folder (no .practi/chain.json)`);
    const chain = loadChain(chainPathFor(dir));
    if (!chain) return fail(`${dir} has an unreadable .practi/chain.json`);
    return { dir, chain, chainPath: chainPathFor(dir), filePath: workingFileFor(dir, chain.name), poolDir: practiDirFor(dir) };
  }
  const fromCwd = findRepoFromCwd(opts.cwd ?? process.cwd());
  if (fromCwd) return fromCwd;
  return fail(
    (opts.verb ?? 'this command') + ' works inside a practice folder — cd into one (or `practi new <name> --base <file>` / `practi clone <owner>/<name>`)'
  );
}

/** 实例的内容池（loadWorkspace 直接挂 .practi——practice.yaml+nodes/，与 practi.json 无涉） */
export function openPool(repo: Repo): Workspace {
  return loadWorkspace(repo.poolDir);
}

/** 诞生实例文件夹：<dir>/<name>/ + .practi/（workspace 标记+空链）。baseDoc 给定则
 *  写入第一版（内容入库+链上 v1+工作文件落盘；message 缺省=pop 名）。返回仓库。
 *  目录已存在=报错；baseDoc 解析不过=报错且不落盘（parseDocument 前置，不留半截壳）。 */
export function createRepo(parentDir: string, name: string, baseDoc?: Record<string, unknown>, message?: string): Repo | null {
  const dir = path.join(path.resolve(parentDir), name);
  if (fs.existsSync(dir)) {
    console.error(`error: ${dir} already exists — a practice folder needs a fresh directory`);
    return null;
  }
  if (baseDoc !== undefined) {
    try {
      parseDocument(baseDoc);
    } catch (e) {
      const err = e as Error & { code?: string; hint?: string };
      console.error(`error [${err.code ?? 'E_SCHEMA'}]: ${err.message}${err.hint ? `\n  hint: ${err.hint}` : ''}`);
      return null;
    }
  }
  const poolDir = practiDirFor(dir);
  fs.mkdirSync(poolDir, { recursive: true });
  try {
    initWorkspace(poolDir);
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && (e as { code?: string }).code === 'E_EXISTS')) throw e;
  }
  const chain: ChainFile = { schema: 1, name, owner: null, current: 'main', branches: { main: null }, commits: [] };
  const repo: Repo = { dir, chain, chainPath: chainPathFor(dir), filePath: workingFileFor(dir, name), poolDir };
  if (baseDoc !== undefined) {
    const ws = openPool(repo);
    let root: string;
    try {
      root = createFromDoc(ws, baseDoc).root;
    } catch (e) {
      console.error(`error [E_SCHEMA]: ${(e as Error).message}`);
      return null;
    }
    chain.commits.push({ seq: 1, root, parent: null, message: message ?? (baseDoc.name as string) ?? '' });
    chain.branches.main = root;
    writeWorkingFile(repo, root);
  }
  saveChain(repo);
  return repo;
}

/** 追加一条提交到当前支（seq=链尾+1）；不碰工作文件（调用方负责） */
export function appendChainCommit(repo: Repo, root: string, message: string): ChainCommit {
  const chain = repo.chain;
  const nextSeq = chain.commits.length > 0 ? Math.max(...chain.commits.map((c) => c.seq)) + 1 : 1;
  const commit: ChainCommit = { seq: nextSeq, root, parent: chainHead(chain), message };
  chain.commits.push(commit);
  chain.branches[chain.current] = root;
  saveChain(repo);
  return commit;
}

/** 把某修订写成工作文件（head 变动后的回写；内容寻址=幂等） */
export function writeWorkingFile(repo: Repo, root: string): void {
  const ws = openPool(repo);
  const node = ws.nodes.get(root);
  if (!node) {
    console.error(`error: revision ${root.slice(0, 19)} not found in the pool — working file not updated`);
    return;
  }
  fs.writeFileSync(repo.filePath, JSON.stringify(exportSubtree(node, ws.nodes), null, 2) + '\n', 'utf8');
}

/** 工作文件的当前内容哈希（未存库也算得出——parseDocument 纯解析）；文件缺失/坏=null */
export function workingRoot(repo: Repo): string | null {
  let text: string;
  try {
    text = fs.readFileSync(repo.filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseDocument(JSON.parse(text)).rootHash;
  } catch {
    return null; // 解析不了的文件按「脏」处理——由调用方给指引
  }
}

/** dirty=工作文件存在且内容哈希 ≠ 当前支头（move-head 类命令的前置守卫） */
export function isDirty(repo: Repo): boolean {
  const head = chainHead(repo.chain);
  const fileRoot = workingRoot(repo);
  if (fileRoot === null) return fs.existsSync(repo.filePath); // 解析失败也算脏
  return fileRoot !== head;
}

export function dirtyGuardMessage(repo: Repo): string {
  return (
    `working file has uncommitted changes — \`practi commit -m "..."\` first` +
    ` (or \`practi export ${chainHead(repo.chain)?.slice(7, 19) ?? ''} -o ${repo.chain.name}.json\` to discard)`
  );
}
