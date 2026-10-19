import fs from 'node:fs';
import path from 'node:path';

/**
 * 本地提交日志（sidecar，不进协议）：commits.json。POP 2.0 起修订历史归仓库层
 * （spec §9.1）——远端落 hub 的实例提交链，本地 edit 的血统记在这里：
 * {hash: 新根, from: 旧根, message, createdAt, pushedAt?}。push 成功时按新根
 * 回填 pushedAt 并把 message 上送 hub（提交说明的唯一来源）；未推送条目即
 * 「本地领先远端的提交」。与 notes.json 同站位：时间与说明不属于内容寻址的
 * 节点本体，侧挂存储；坏文件/坏条目降级跳过（与 loadState/loadNotes 同口径）。
 */
export const COMMITS_FILE = 'commits.json';

export interface CommitEntry {
  /** 本次编辑产生的新根哈希（全形 sha256:<64hex>） */
  hash: string;
  /** 编辑前的根哈希；没有前身（本地新建）为 null */
  from: string | null;
  message: string;
  createdAt: string;
  /** push 成功后回填（hub 已按此哈希登记提交并采用本条 message） */
  pushedAt?: string;
}

export interface CommitsFile {
  schema: 1;
  commits: CommitEntry[];
}

export function commitsPath(dataDir: string): string {
  return path.join(dataDir, COMMITS_FILE);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 读取并消毒：文件缺失/损坏/条目坏一律降级，逐条过滤不致命 */
export function loadCommits(dataDir: string): CommitsFile {
  const empty: CommitsFile = { schema: 1, commits: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(commitsPath(dataDir), 'utf8');
  } catch {
    return empty;
  }
  try {
    const rec = asRecord(JSON.parse(raw));
    if (rec === null || !Array.isArray(rec.commits)) return empty;
    const commits: CommitEntry[] = [];
    for (const item of rec.commits) {
      const r = asRecord(item);
      if (!r) continue;
      const { hash, from, message, createdAt, pushedAt } = r as Record<string, unknown>;
      if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) continue;
      if (from !== null && (typeof from !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(from))) continue;
      if (typeof message !== 'string' || typeof createdAt !== 'string') continue;
      const entry: CommitEntry = { hash, from: from === null ? null : from, message, createdAt };
      if (typeof pushedAt === 'string') entry.pushedAt = pushedAt;
      commits.push(entry);
    }
    return { schema: 1, commits };
  } catch {
    return empty;
  }
}

export function saveCommits(dataDir: string, file: CommitsFile): void {
  fs.writeFileSync(commitsPath(dataDir), JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 追加一条本地提交（edit 换根后调用；message 缺省由调用方给） */
export function appendCommit(dataDir: string, hash: string, from: string | null, message: string): CommitEntry {
  const file = loadCommits(dataDir);
  const entry: CommitEntry = { hash, from, message, createdAt: new Date().toISOString() };
  file.commits.push(entry);
  saveCommits(dataDir, file);
  return entry;
}

/** 未推送条目（本地领先远端的提交，新→旧） */
export function unpushedCommits(dataDir: string): CommitEntry[] {
  return loadCommits(dataDir).commits.filter((c) => c.pushedAt === undefined).reverse();
}

/** 该哈希对应的未推送 message（取最新一条）；没有未推送条目返回 undefined */
export function messageFor(dataDir: string, hash: string): string | undefined {
  const hits = loadCommits(dataDir).commits.filter((c) => c.hash === hash && c.pushedAt === undefined);
  return hits.length > 0 ? hits[hits.length - 1].message : undefined;
}

/** push 成功后按新根盖戳：同哈希的全部未推送条目一起结清（from 不同的重复编辑同内容时会出现多条） */
export function markPushed(dataDir: string, hash: string): void {
  const file = loadCommits(dataDir);
  const now = new Date().toISOString();
  let touched = false;
  for (const c of file.commits) {
    if (c.hash === hash && c.pushedAt === undefined) {
      c.pushedAt = now;
      touched = true;
    }
  }
  if (touched) saveCommits(dataDir, file);
}
