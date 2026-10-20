import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, loadState } from './state.js';
import { initDataDir } from './workspace.js';

/**
 * practice 实例仓库（2026-10-20 双软件模型）：一篇 pop 的血统仓库，两种存放——
 * - registry：默认工作目录账本登记，链文件在 practices/<name>/chain.json（薄目录，
 *   物理内容仍走共享 nodes 寻址池——Q2 拍板逻辑分区）
 * - directory：任意目录即仓库（<dir>/chain.json + <dir>/practice.yaml），自带节点池
 * 链文件与 hub revisions 同构（seq/root/parent/message + 支指针表），本地重写自由，
 * push 时与 hub 对账（分叉报错，--force 覆盖）。
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

export interface PracticeRepo {
  kind: 'registry' | 'directory';
  /** registry=默认工作目录；directory=实例目录自身（节点池所在地） */
  dataDir: string;
  chainPath: string;
  chain: ChainFile;
}

export function chainPathFor(dataDir: string, name: string): string {
  return path.join(dataDir, 'practices', name, 'chain.json');
}

function isHash(v: unknown): v is string {
  return typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
}

/** 读链文件，坏文件/坏条目降级跳过（与 loadState/loadCommits 同口径） */
export function loadChain(file: string, expectName?: string): ChainFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (rec.schema !== 1 || typeof rec.name !== 'string') return null;
    if (expectName !== undefined && rec.name !== expectName) return null;
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

export function saveChain(repo: PracticeRepo): void {
  fs.mkdirSync(path.dirname(repo.chainPath), { recursive: true });
  fs.writeFileSync(repo.chainPath, JSON.stringify(repo.chain, null, 2) + '\n', 'utf8');
}

/** 当前支头（空仓库=null） */
export function chainHead(chain: ChainFile, branch?: string): string | null {
  return chain.branches[branch ?? chain.current] ?? null;
}

/** 指定目录是不是一个实例仓库（chain.json 在） */
export function isPracticeDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'chain.json'));
}

/** cwd（或其祖先）是否坐在一个实例目录里；命中返回仓库 */
export function findPracticeDirFromCwd(cwd: string): PracticeRepo | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (isPracticeDir(dir)) {
      const chain = loadChain(path.join(dir, 'chain.json'));
      if (chain) {
        return { kind: 'directory', dataDir: dir, chainPath: path.join(dir, 'chain.json'), chain };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 定位当前实例（cwd 检测 + 显式覆盖）：
 * - explicitDir 给定（--dir）：必须是实例目录
 * - explicitName 给定（--to/--practice）：默认工作目录账本里按名查
 * - 否则：cwd 命中实例目录→用它；未命中→默认工作目录账本里恰一个实例→用它，
 *   0 或多个→报错（要求显式），返回 null 并已打印错误 */
export function resolvePractice(opts: {
  dataDir?: string;
  explicitDir?: string;
  explicitName?: string;
  cwd?: string;
  /** 定位失败时的错误行前缀 */
  verb?: string;
}): PracticeRepo | null {
  const fail = (msg: string): null => {
    console.error(`error: ${msg}`);
    return null;
  };
  if (opts.explicitDir) {
    const dir = path.resolve(opts.explicitDir);
    if (!isPracticeDir(dir)) return fail(`${dir} is not a practice repo (no chain.json)`);
    const chain = loadChain(path.join(dir, 'chain.json'));
    if (!chain) return fail(`${dir} has an unreadable chain.json`);
    return { kind: 'directory', dataDir: dir, chainPath: path.join(dir, 'chain.json'), chain };
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  if (opts.explicitName) {
    const p = chainPathFor(dataDir, opts.explicitName);
    if (!fs.existsSync(p)) return fail(`no practice named "${opts.explicitName}" in the workspace (practi practice list)`);
    const chain = loadChain(p, opts.explicitName);
    if (!chain) return fail(`practice "${opts.explicitName}" has an unreadable chain.json`);
    return { kind: 'registry', dataDir, chainPath: p, chain };
  }
  const fromCwd = findPracticeDirFromCwd(opts.cwd ?? process.cwd());
  if (fromCwd) return fromCwd;
  const practices = listRegistryPractices(dataDir);
  if (practices.length === 1) return practices[0];
  if (practices.length === 0) {
    return fail(
      (opts.verb ?? 'this command') + ' works inside a practice — run `practi practice new <name>` or `practi clone <owner>/<name>` first'
    );
  }
  return fail(
    `${practices.length} practices in the workspace — pass --practice <name> or run inside the practice's directory`
  );
}

/** 默认工作目录账本里的全部 registry 式实例 */
export function listRegistryPractices(dataDir: string): PracticeRepo[] {
  const dir = path.join(dataDir, 'practices');
  if (!fs.existsSync(dir)) return [];
  const out: PracticeRepo[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = chainPathFor(dataDir, name);
    const chain = loadChain(p, name);
    if (chain) out.push({ kind: 'registry', dataDir, chainPath: p, chain });
  }
  return out;
}

/** 新建一个实例仓库（registry 式；directory 式用 --dir 传目标目录——目录初始化为
 *  独立 POP 工作区，自带节点池） */
export function createPractice(dataDir: string, name: string, dir?: string): PracticeRepo {
  const chain: ChainFile = {
    schema: 1,
    name,
    owner: null,
    current: 'main',
    branches: { main: null },
    commits: [],
  };
  if (dir) {
    initDataDir(path.resolve(dir));
  }
  const repo: PracticeRepo = dir
    ? { kind: 'directory', dataDir: path.resolve(dir), chainPath: path.join(path.resolve(dir), 'chain.json'), chain }
    : { kind: 'registry', dataDir, chainPath: chainPathFor(dataDir, name), chain };
  saveChain(repo);
  return repo;
}

/** 删本地实例（registry 式：撤登记+删链目录；hub 不动） */
export function removeRegistryPractice(dataDir: string, name: string): boolean {
  const p = chainPathFor(dataDir, name);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
  return true;
}

/** 实例的节点池目录（directory 式自带池；registry 式=共享工作区池） */
export function repoDataDir(repo: PracticeRepo, fallbackDataDir: string): string {
  return repo.kind === 'directory' ? repo.dataDir : fallbackDataDir;
}

/** 追加一条提交到当前支（publish/amend 用；seq=链尾+1，全局链序） */
export function appendChainCommit(repo: PracticeRepo, root: string, message: string): ChainCommit {
  const chain = repo.chain;
  const nextSeq = chain.commits.length > 0 ? Math.max(...chain.commits.map((c) => c.seq)) + 1 : 1;
  const commit: ChainCommit = { seq: nextSeq, root, parent: chainHead(chain), message };
  chain.commits.push(commit);
  chain.branches[chain.current] = root;
  saveChain(repo);
  return commit;
}

/** 遥测用：默认工作目录里 name 是否已被 registry 实例占用 */
export function registryNameTaken(dataDir: string, name: string): boolean {
  return fs.existsSync(chainPathFor(dataDir, name));
}
