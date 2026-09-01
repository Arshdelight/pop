import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { shortHash } from '../render.js';

/**
 * practi gc — 清架工：清理孤儿 blob（盘上存在、但没有任何已存节点引用的附件字节）。
 * 引用判定刻意取「盘上全部节点」而非「direct 可达」——edit --keep 留下的节点、间接
 * 节点挂着的附件都算被引用，清架只清真正无主的字节（edit 的 GC 不碰 blobs，字节
 * 只有这道手动门）。默认 dry-run 只报不清，--apply 才动手；nodes 不归它管。
 */

export interface GcOpts {
  dataDir?: string;
  apply: boolean;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function runGc(opts: GcOpts): number {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const ws = openWorkspace(dataDir);

  // 附件只长在 action 上（schema 保证 practice 无 attachments），扫一遍全部节点即可
  const referenced = new Set<string>();
  for (const node of ws.nodes.values()) {
    if (node.type !== 'action') continue;
    for (const att of node.attachments ?? []) referenced.add(att.hash);
  }

  const orphans: { hash: string; file: string; size: number }[] = [];
  const blobsDir = path.join(dataDir, 'blobs');
  if (fs.existsSync(blobsDir)) {
    for (const shard of fs.readdirSync(blobsDir)) {
      const shardDir = path.join(blobsDir, shard);
      let names: string[];
      try {
        names = fs.readdirSync(shardDir);
      } catch {
        continue; // 非目录条目（人手放的杂物）：不删不报，只跳过
      }
      for (const name of names) {
        const hash = `sha256:${name}`;
        if (referenced.has(hash)) continue;
        const file = path.join(shardDir, name);
        let size: number;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue; // 扫描瞬间被人拿走：跳过
        }
        orphans.push({ hash, file, size });
      }
    }
  }

  if (orphans.length === 0) {
    console.log('gc: no orphan blobs');
    return 0;
  }

  const freed = orphans.reduce((s, o) => s + o.size, 0);
  console.log(
    `gc: ${orphans.length} orphan blob(s), ${fmtBytes(freed)}${opts.apply ? ' — removed' : ' — dry run, pass --apply to remove'}`
  );
  for (const o of orphans) console.log(`  ${shortHash(o.hash)}`);
  if (opts.apply) {
    for (const o of orphans) fs.unlinkSync(o.file);
    // 抽屉清空了就顺手撤掉（撤不掉=还有东西，不硬来）
    for (const dir of new Set(orphans.map(o => path.dirname(o.file)))) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // 非空或已消失：留着无妨
      }
    }
  }
  return 0;
}
