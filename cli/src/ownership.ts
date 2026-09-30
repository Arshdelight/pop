import type { Workspace } from '@arshdelight/pop-sdk';

/**
 * direct 归属计算：**只从 direct 根出发**，与「匹配集合」解耦。
 *
 * - owner / depthOf 沿用 edit·remove 的 GC 可达性口径：沿 children pins **与
 *   inputs.from** 引用走。所以「只被某个 action 的 inputs.from 引用」的节点是
 *   可达的，不该被标成孤儿（旧实现只沿 children 走，与 GC 口径不一致）。
 * - size 取 children 闭包（这棵树有多少步），不含流引用的外部节点。
 *
 * search 与 similar 共用同一份判定：可达性只定义一次，不能各算各的。
 */
export interface Ownership {
  /** hash → 拥有它的 direct 根（共享子树可属多个根） */
  owner: Map<string, string[]>;
  /** hash → 树内最小深度（direct 根 = 0）；不可达节点不入表 */
  depthOf: Map<string, number>;
  /** direct 根 → 其 children 闭包节点数 */
  size: Map<string, number>;
  /** 仍存在于工作区的 direct 根（按注册顺序） */
  direct: string[];
  directSet: Set<string>;
}

export function computeOwnership(ws: Workspace, stateDirect: string[]): Ownership {
  const direct = stateDirect.filter(h => ws.nodes.has(h));
  const owner = new Map<string, string[]>();
  const depthOf = new Map<string, number>();
  const size = new Map<string, number>();

  for (const root of direct) {
    // 1) 可达闭包（children + inputs.from）→ 归属 + 深度
    const seen = new Set<string>();
    const stack: [string, number][] = [[root, 0]];
    while (stack.length > 0) {
      const [h, d] = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      const n = ws.nodes.get(h);
      if (n === undefined) continue;
      const list = owner.get(h) ?? [];
      if (!list.includes(root)) list.push(root);
      owner.set(h, list);
      const prev = depthOf.get(h);
      if (prev === undefined || d < prev) depthOf.set(h, d);
      if (n.type === 'practice') {
        for (const c of n.children) stack.push([c.hash, d + 1]);
      } else {
        for (const inp of n.inputs ?? []) {
          if (inp.from !== undefined) stack.push([inp.from, d + 1]);
        }
      }
    }

    // 2) children 闭包 → 树规模
    const childSeen = new Set<string>();
    const cstack = [root];
    while (cstack.length > 0) {
      const h = cstack.pop()!;
      if (childSeen.has(h)) continue;
      childSeen.add(h);
      const n = ws.nodes.get(h);
      if (n?.type === 'practice') for (const c of n.children) cstack.push(c.hash);
    }
    size.set(root, childSeen.size);
  }

  return { owner, depthOf, size, direct, directSet: new Set(direct) };
}
