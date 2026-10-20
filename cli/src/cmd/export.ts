import fs from 'node:fs';
import { exportSubtree, resolveNodeRef } from '@arshdelight/pop-sdk';
import { openPool, resolveRepo } from '../practice.js';
import { shortHash } from '../render.js';

export interface ExportOpts {
  positional: string[];
  /** -o <file>：写入文件（缺省=打印到 stdout，可管道） */
  out?: string;
  dir?: string;
}

/**
 * practi export <hash> [-o <file>]：取实例池中的任意修订为 pop 文档 JSON。
 * 当前版直接改工作文件即可；export 服务于历史旧版（对照/回滚参考）。
 * 管道形态无装饰输出；-o 落盘时确认行走 stdout。
 */
export function runExport(opts: ExportOpts): number {
  const repo = resolveRepo({ dir: opts.dir, verb: 'export' });
  if (repo === null) return 1;
  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: practi export <hash> [-o <file>]   (hash prefix OK — revisions live in this practice)');
    return 1;
  }
  const ws = openPool(repo);
  let hash: string;
  try {
    hash = resolveNodeRef(ws, ref);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
  const node = ws.nodes.get(hash);
  if (!node) {
    console.error(`error: node not found: ${hash}`);
    return 1;
  }
  const json = JSON.stringify(exportSubtree(node, ws.nodes), null, 2) + '\n';
  if (opts.out) {
    fs.writeFileSync(opts.out, json, 'utf8');
    console.log(`exported: ${shortHash(hash)} → ${opts.out}`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}
