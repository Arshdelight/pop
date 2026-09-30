import type { PNode } from './model.js';

/**
 * 记录质量体检 —— **非阻断**提示（W_*）。
 *
 * 与 §6 的 `E_*` 严格分开，这是本模块存在的全部理由：
 *  - `E_*` 是校验不变量，命中即**拒收**：节点落盘但不登记（`practi new` 退出 1）；
 *  - `W_*` 是写作质量提示，**永远不改变结果**：带 W_ 的文档与不带 W_ 的文档在
 *    存储、哈希、登记上完全一样，退出码不变。
 *
 * 规格把 W_* 定为 non-normative（pop-spec §6）：**码表是共享词汇，阈值是实现策略**
 * （与资源上限、blob 大小同级的实现自由度）。它只是把 SKILL.md 里原本只有人类可读
 * 的散文规则，变成机器也能给出的反馈——语料不该在「一句话」和「11 节点长文」之间
 * 随机漂移。
 */

export interface QualityWarning {
  /** `W_` 前缀的提示码（pop-spec §6 的非规范码表） */
  code: string;
  /** 触发提示的节点哈希 */
  hash: string;
  /** 该节点名（给人看） */
  name: string;
  message: string;
}

export interface QualityThresholds {
  /** action 的 content 去空白后短于此值，且没有 attachments → 过薄 */
  minContentChars: number;
  /** practice 的子节点多于此值且全是 action → 该分组的没分组（`set` 目录视图不算） */
  maxFlatChildren: number;
  /** 树深超过此值 → 阅读负担 */
  maxDepth: number;
}

/**
 * 阈值是实现策略（pop-spec §6），所以它们是在真实语料上校准过的，不是拍脑袋：
 * 一份 772 节点 / 113 棵扁平 practice 的语料里，扁平树的子节点数是 p50=5、p90=9、max=12。
 * 原来的「> 5」会命中 47% 的实践——那不是信号，是用户会学会无视的噪声；
 * 取 p90 边界（> 8，即 9 步以上才开始读得累）命中约 13%，是真正的离群值。
 */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minContentChars: 40,
  maxFlatChildren: 8,
  maxDepth: 6,
};

/** 无信息量的名字：占位词（可带序号），或纯数字/标点 */
const VAGUE_NAME_RE = /^(步骤|第\s*\d+\s*步|step|do|todo|处理|完成|其他|未命名|untitled|unnamed)\s*\d*$/i;
const PLACEHOLDER_ONLY_RE = /^[\d\s.、,，:：;；\-—_/\\|]+$/;

function isVagueName(name: string): boolean {
  const n = name.trim();
  return n === '' || VAGUE_NAME_RE.test(n) || PLACEHOLDER_ONLY_RE.test(n);
}

/**
 * 对若干棵子树做体检，返回全部 W_* 提示（可能为空）。纯函数、只读、确定性：
 * 同一输入两次调用结果完全一致（遍历序由 children 顺序固定，输出按 hash+code 排序）。
 *
 * 去重的粒度刻意分两种：
 *  - **节点级**提示（内容薄/无产出/名字含糊/扁平/缺描述）是节点自身的属性 →
 *    同一个节点被两棵树引用时只报一次；
 *  - **树级**提示（深度、同名）是「这棵树」的属性 → 每棵树各报各的，不去重。
 * 每次调用的根都是一份将要创建的文档，把两者混在一起会漏报。
 */
export function qualityWarnings(
  roots: readonly string[],
  nodes: Map<string, PNode>,
  overrides: Partial<QualityThresholds> = {},
): QualityWarning[] {
  const t: QualityThresholds = { ...DEFAULT_QUALITY_THRESHOLDS, ...overrides };
  const out: QualityWarning[] = [];
  const nodeSeen = new Set<string>();
  const pushNode = (w: QualityWarning): void => {
    const key = `${w.code}\u0000${w.hash}`;
    if (nodeSeen.has(key)) return;
    nodeSeen.add(key);
    out.push(w);
  };

  for (const root of roots) {
    // 本次子树的完整视图（每棵树都要走全，树级判断依赖它）
    const depth = new Map<string, number>();
    const byName = new Map<string, string[]>();
    const stack: [string, number][] = [[root, 0]];
    while (stack.length > 0) {
      const [h, d] = stack.pop()!;
      if (depth.has(h)) continue;
      depth.set(h, d);
      const n = nodes.get(h);
      if (n === undefined) continue;
      const list = byName.get(n.name) ?? [];
      list.push(h);
      byName.set(n.name, list);
      if (n.type === 'practice') for (const c of n.children) stack.push([c.hash, d + 1]);
    }

    // 树级：深度（报在根上，一次就够——逐节点报会把输出淹掉）
    const rootNode = nodes.get(root);
    let maxDepth = 0;
    for (const d of depth.values()) if (d > maxDepth) maxDepth = d;
    if (rootNode !== undefined && maxDepth > t.maxDepth) {
      out.push({
        code: 'W_DEEP_TREE',
        hash: root,
        name: rootNode.name,
        message: `this tree reaches depth ${maxDepth} (limit ${t.maxDepth}) — a deep tree is a reading burden; group steps into sub-practices`,
      });
    }

    // 树级：同名（同名节点会让 @label 导出退化成哈希 pin，也让阅读与引用都变含糊）
    for (const [name, hashes] of byName) {
      if (hashes.length > 1) {
        out.push({
          code: 'W_DUP_NAME',
          hash: hashes[0],
          name,
          message: `${hashes.length} nodes in this tree are named "${name}" — same-name nodes make "@name" export fall back to hash pins`,
        });
      }
    }

    // 节点级（同一节点被多棵树引用时只报一次 —— 这些是节点自身的属性）
    for (const [h, d] of depth) {
      const n = nodes.get(h);
      if (n === undefined) continue;
      if (n.type === 'action') {
        const len = n.content.trim().length;
        if (len < t.minContentChars && (n.attachments ?? []).length === 0) {
          pushNode({
            code: 'W_THIN_CONTENT',
            hash: h,
            name: n.name,
            message: `content is ${len} char${len === 1 ? '' : 's'} (limit ${t.minContentChars}) and there are no attachments — nobody else can reproduce this from what is written`,
          });
        }
        if ((n.outputs ?? []).length === 0) {
          pushNode({
            code: 'W_NO_VERIFY',
            hash: h,
            name: n.name,
            message: 'no outputs declared — a step with no acceptance criteria cannot be verified',
          });
        }
      } else {
        // set 是目录视图：一集一个条目本来就该多子节点，不是「该分组的没分组」
        if (n.op !== 'set' && n.children.length > t.maxFlatChildren
          && n.children.every(c => nodes.get(c.hash)?.type === 'action')) {
          pushNode({
            code: 'W_FLAT_TREE',
            hash: h,
            name: n.name,
            message: `${n.children.length} child steps, none of them grouped (limit ${t.maxFlatChildren}) — group related steps into sub-practices`,
          });
        }
        if (d === 0 && (n.description === undefined || n.description.trim() === '')) {
          pushNode({
            code: 'W_DESC_MISSING',
            hash: h,
            name: n.name,
            message: 'practice root without a description — the description is what search matches on first, so this is the hardest node to find again',
          });
        }
      }
      if (isVagueName(n.name)) {
        pushNode({
          code: 'W_VAGUE_NAME',
          hash: h,
          name: n.name,
          message: 'this name carries no information — name it after what it actually does',
        });
      }
    }
  }

  // 稳定序：节点分组（hash 升序），组内按码
  out.sort((a, b) =>
    (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return out;
}
