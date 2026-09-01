import fs from 'node:fs';
import { loadWorkspace, resolveNodeRef, nodeFilePath } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { collectUnreachable } from './edit.js';
import { runDelete } from './lifecycle.js';

/**
 * practi remove <hash>：把一个 direct 根从本地目录拿掉——注册层操作（direct≈git refs，
 * refs 的增删不产生新 commit，不走内容层换根那条 edit 路），随后按 edit 同款规则 GC
 * 从剩余 direct 出发不可达的节点（共享的间接节点保得住）。
 * --remote 改为撤远端认领（原 practi delete 的活；delete 已退役，这是唯一面孔）。
 * 笔记不动：钉在旧哈希上的自动成为悬空组（note list 殿后展示；内容若从 hub 复得，
 * 哈希不变，笔记自动重新挂上）。
 */

export interface RemoveOpts {
  dataDir?: string;
  remote?: boolean;
  positional: string[];
}

function short(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 10);
}

export async function runRemove(opts: RemoveOpts): Promise<number> {
  if (opts.remote === true) {
    return runDelete({ dataDir: opts.dataDir, positional: opts.positional });
  }

  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: practi remove <hash>   (take a direct pop out of the local directory; unreachable nodes are GCed)');
    console.error('       practi remove <hash> --remote   (withdraw the claim on the remote instead)');
    return 1;
  }

  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const ws = openWorkspace(dataDir);
  const root = resolveNodeRef(ws, ref);
  if (!state.direct.includes(root)) {
    console.error(`error: ${root} is not one of your direct pops — remove takes a direct root out of the local directory;`);
    console.error('       indirect nodes live inside direct trees (`practi ls -a`), leave by removing their root');
    return 1;
  }

  state.direct = state.direct.filter((h) => h !== root);
  saveState(dataDir, state); // claims 修剪在写盘口：被删根的认领时刻随之失效
  console.log(`removed:  ${root} from the local directory`);

  const dead = collectUnreachable(loadWorkspace(dataDir), state.direct);
  for (const h of dead) fs.unlinkSync(nodeFilePath(dataDir, h));
  console.log(
    `gc:       removed ${dead.length} unreachable node(s)${dead.length > 0 ? ` — ${dead.map(short).join(', ')}` : ''}`
  );
  if (dead.length > 0) {
    console.log('hint:     blobs stay with their bytes — `practi gc` sweeps orphans when you want');
  }
  if (state.remote) {
    console.log(`remote:   the hub copy (if pushed) stays — withdraw with \`practi remove ${short(root)} --remote\``);
  }
  return 0;
}
