import { resolveNodeRef, computeNodeHash, nodeFilePath, type PNode, type Workspace } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState, claimDirect } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { collectUnreachable } from './edit.js';
import fs from 'node:fs';
import { shortHash } from '../render.js';

/**
 * practi claim / unclaim：direct ⇄ indirect 认领转换（registry 层操作，不碰内容层）。
 * direct ≈ git refs：被引用的对象既可以是 direct 也可以是 indirect，两者合法、随时可逆。
 * - claim：把工作区里已存在的任意节点登记为 direct 根（indirect → direct 的入口）。
 * - unclaim：把 direct 根撤出注册表（direct → indirect）。前提：仍被其它 direct 引用——
 *   否则撤完立刻成孤儿被 GC，等于变相删除；那是 `practi remove`（显式删除）的职责，不是转换。
 */

export interface ClaimOpts {
  dataDir?: string;
  positional: string[];
}

export function runClaim(opts: ClaimOpts): number {
  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: practi claim <hash>   (register an existing stored node as a direct pop)');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const ws = openWorkspace(dataDir);
  const root = resolveNodeRef(ws, ref);
  if (!claimDirect(state, root)) {
    console.error(`error: ${root} is already registered as a direct pop`);
    return 1;
  }
  saveState(dataDir, state);
  console.log(`claimed:  ${root}`);
  console.log(`          ${ws.nodes.get(root)!.name}`);
  return 0;
}

/**
 * 引用 target 的节点名单（两种引用都算：practice 的 children pin、action 的 inputs.from）。
 * 与可达性口径一致，否则会出现「unclaim 成功但一个引用者都不打印」的怪象。
 */
function listReferencers(ws: Workspace, roots: readonly string[], target: string): string[] {
  const seen = new Set<string>();
  const out = new Map<string, string>();
  const stack: PNode[] = [];
  for (const h of roots) {
    const n = ws.nodes.get(h);
    if (n !== undefined) stack.push(n);
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const curHash = computeNodeHash(cur);
    if (seen.has(curHash)) continue;
    seen.add(curHash);
    const refs = cur.type === 'practice'
      ? cur.children.some((c) => c.hash === target)
      : (cur.inputs ?? []).some((i) => i.from === target);
    if (refs) out.set(curHash, `${cur.name} (${shortHash(curHash)})`);
    if (cur.type === 'practice') {
      for (const c of cur.children) {
        const child = ws.nodes.get(c.hash);
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return [...out.values()];
}

export function runUnclaim(opts: ClaimOpts): number {
  const ref = opts.positional[0];
  if (!ref) {
    console.error('usage: practi unclaim <hash>   (take a referenced direct pop back to indirect; fails when unreferenced)');
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  const ws = openWorkspace(dataDir);
  const root = resolveNodeRef(ws, ref);
  if (!state.direct.includes(root)) {
    console.error(`error: ${root} is not a direct pop (nothing to unclaim — check \`practi ls\`)`);
    return 1;
  }

  const rest = state.direct.filter((h) => h !== root);
  // 「还被引用吗」必须与 GC 用**同一套**可达性（children pins + inputs.from）。旧实现只沿
  // children 走，于是这道闸比 GC 更严：只被某个 action 的 `from` 引用的节点会被拒，
  // 而 GC 根本不会删它——报错信息「the next GC deletes it」也就成了假的。
  // 复用 collectUnreachable，判定只定义一次。
  if (collectUnreachable(ws, rest).includes(root)) {
    console.error(`error [E_NOT_REFERENCED]: ${root} is not referenced by any other direct pop —`);
    console.error('       unclaiming would orphan it (the next GC deletes it). If you mean to delete it, use `practi remove`.');
    return 1;
  }

  state.direct = rest;
  saveState(dataDir, state);
  const referencers = listReferencers(ws, rest, root);
  console.log(`unclaimed: ${root} — now indirect`);
  if (referencers.length > 0) console.log(`           referenced by: ${referencers.join(', ')}`);

  const dead = collectUnreachable(ws, state.direct);
  for (const h of dead) fs.unlinkSync(nodeFilePath(dataDir, h));
  if (dead.length > 0) {
    console.log(`gc:       removed ${dead.length} unreachable node(s) — ${dead.map(shortHash).join(', ')}`);
  }
  return 0;
}
