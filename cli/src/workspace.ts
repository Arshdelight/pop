import fs from 'node:fs';
import path from 'node:path';
import { PracticeError, initWorkspace, loadWorkspace, type Workspace } from '@arshdelight/pop-sdk';
import { statePath, legacyStatePath } from './state.js';

/** A data dir is initialized when it carries both the CLI state (practi.json,
 *  legacy pop.json counts) and the POP workspace marker */
export function isInitialized(dataDir: string): boolean {
  const hasState = fs.existsSync(statePath(dataDir)) || fs.existsSync(legacyStatePath(dataDir));
  return hasState && fs.existsSync(path.join(dataDir, 'practice.yaml'));
}

export function requireDataDir(dataDir: string): void {
  if (!isInitialized(dataDir)) {
    throw new PracticeError('E_NOT_INITIALIZED', `no practi data directory at ${dataDir}`, {
      hint: 'run `practi init <path>` first (or pass --data-dir)',
    });
  }
}

export function openWorkspace(dataDir: string): Workspace {
  requireDataDir(dataDir);
  return loadWorkspace(dataDir);
}

/** 节点文件的系统 mtime：这份内容落进本工作区的时刻（new/edit=创建或编辑时刻；
 *  clone/pull=拉取时刻，非原创时刻）。repair 用它给老数据补认领戳 */
export function nodeFileTime(dataDir: string, hash: string): string | null {
  try {
    return fs.statSync(path.join(dataDir, 'nodes', `${hash.slice('sha256:'.length)}.md`)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Create the data dir (idempotent): workspace + CLI state. Adopts an existing workspace if present. */
export function initDataDir(dataDir: string): 'created' | 'exists' {
  fs.mkdirSync(dataDir, { recursive: true });
  if (isInitialized(dataDir)) return 'exists';
  try {
    initWorkspace(dataDir);
  } catch (e) {
    // practice.yaml already exists (workspace created by another tool); we still adopt it
    if (!(e instanceof PracticeError && e.code === 'E_EXISTS')) throw e;
  }
  fs.writeFileSync(statePath(dataDir), JSON.stringify({ schema: 1, direct: [] }, null, 2) + '\n', 'utf8');
  return 'created';
}

/**
 * 本次操作子树的节点文件集（nodes/<hex>.md，与 sdk validateWorkspace 的 issue.file 同形态）。
 * new/edit 的注册门禁只统计本次子树的校验问题——workspace 里其它文档的历史问题
 * （如 v1.1.0 前写的外链 media 引用、缺字节旧附件）不连坐本次创建/编辑的注册。
 */
export function subtreeFiles(ws: Workspace, root: string): Set<string> {
  const out = new Set<string>();
  const walk = (h: string): void => {
    // 与 sdk validateWorkspace 的 issue.file 同构（nodeFile 用 path.join——Windows 反斜杠）
    const f = path.join('nodes', `${h.slice('sha256:'.length)}.md`);
    if (out.has(f)) return;
    out.add(f);
    const n = ws.nodes.get(h);
    if (n && n.type !== 'action') {
      for (const c of n.children) walk(c.hash);
    }
  };
  walk(root);
  return out;
}
