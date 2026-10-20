import path from 'node:path';
import type { Workspace } from '@arshdelight/pop-sdk';

/**
 * 实例池工具：文件夹模型下节点池在 <实例>/.practi/（practice.yaml+nodes/+blobs/），
 * 打开一律走 practice.ts 的 openPool(repo)——本文件只留子树文件集这一个通用件。
 */

/**
 * 本次操作子树的节点文件集（nodes/<hex>.md，与 sdk validateWorkspace 的 issue.file 同形态）。
 * commit/new 的门禁只统计本次子树的校验问题——池里其它文档的历史问题
 * （如 v1.1.0 前写的外链 media 引用、缺字节旧附件）不连坐本次提交。
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

export const PRACTI_DIRNAME = '.practi';
export function poolPathFor(dir: string): string {
  return path.join(dir, '.practi');
}
