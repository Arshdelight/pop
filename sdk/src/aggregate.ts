import { PracticeError } from './errors.js';
import { computeNodeHash } from './hash.js';
import type { Attachment, Op, PNode, PracticeNode } from './model.js';

export interface StepItem {
  /** The step node's content hash — the only address (renderers show `name` to humans) */
  refHash: string;
  name: string;
  depth: number;
  note?: string;
  /** --full only: the action's content (human-readable details) */
  content?: string;
  /** The action's caveats and pitfalls (POP 2.2.0 `notice`) — always carried: a skeleton read without the warnings is not the practice */
  notice?: string;
  /** set directory entries only: the child practice's description */
  description?: string;
  /** The referenced node file is absent from this workspace — the entry is a placeholder (read tolerance; creation refuses dangling pins) */
  missing?: boolean;
}

/** A child pin whose node file is absent from this workspace, with its referencing parent */
export interface MissingRef {
  hash: string;
  parentHash: string;
  parentName: string;
}

/** Aggregate-view attachment entry: pointer + originating action (by hash) */
export interface AttachmentView extends Attachment {
  refHash: string;
}

/** Flow edge: name flows from fromHash to toHash (hashes already resolved; zero dependencies for renderers) */
export interface FlowEdge {
  name: string;
  fromHash: string;
  fromName: string;
  toHash: string;
  toName: string;
}

/**
 * A declared flow entry with provenance: which action declares it. `outputs`
 * answers "what can this practice produce" (acceptance criteria), `inputs`
 * answers "what does it need" — unwired inputs (no `from`) are needs all the
 * same and appear here even though they generate no flow edge.
 */
export interface FlowDeclarationView {
  name: string;
  spec?: string;
  /** The declaring action's hash */
  refHash: string;
}

/**
 * Standard view: a practice's steps/attachments/flow are derived bottom-up
 * from the subtree, never stored. Reading any node yields the standardized
 * view at that granularity. Nodes are addressed by hash throughout.
 */
export interface StandardView {
  /** Node content hash (identity is content; addressable by unique prefix) */
  hash: string;
  type: 'action' | 'practice';
  op?: Op;
  name: string;
  description?: string;
  /** The root node's reuse terms / extension bag (not aggregated from the subtree) */
  license?: string;
  metadata?: Record<string, unknown>;
  /** The root node's content (human narrative) */
  content?: string;
  /** The root node's caveats and pitfalls (POP 2.2.0 `notice`) */
  notice?: string;
  steps: StepItem[];
  attachments: AttachmentView[];
  flow: FlowEdge[];
  /** Declared needs/productions aggregated from the subtree (§7), with provenance */
  inputs: FlowDeclarationView[];
  outputs: FlowDeclarationView[];
  /**
   * 派生的「对外清单」（§7，由 inputs/outputs 与 flow 边算出，不另存）：
   * - externalInputs：没有任何 flow 边供给的 declared input——实践之外要备好的东西（「需要准备」）
   * - finalOutputs：没有任何 flow 边消费的 declared output——实践最终交出的东西（「你会得到」）
   * 中间产物（被下游步骤消费的 output）与中间需求（由上游供给的 input）都不在其中。
   */
  externalInputs: FlowDeclarationView[];
  finalOutputs: FlowDeclarationView[];
  /** Child pins whose node files are absent (read tolerance: the view still renders; creation-time import remains strict) */
  missing?: MissingRef[];
}

interface Acc {
  steps: StepItem[];
  attachments: AttachmentView[];
  flow: FlowEdge[];
  inputs: FlowDeclarationView[];
  outputs: FlowDeclarationView[];
  missing: MissingRef[];
}

/** Attachment dedup key: hash fixes the content, name fixes the use (same blob under a different name = different use, kept) */
function attachmentKey(a: AttachmentView): string {
  return `${a.hash}\u0000${a.name}`;
}

function joinNote(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}

function loopCount(node: PracticeNode): number {
  return node.loop?.mode === 'count' ? node.loop.count : 1;
}

/** Loop annotation: count is a static description (repeat N times); until is an open predicate (repeat until …, never inventing a count) */
function loopNote(node: PracticeNode): string {
  if (node.loop?.mode === 'until') return `repeat until: ${node.loop.until}`;
  return `repeat ${loopCount(node)} times`;
}

export function aggregateView(rootHash: string, nodes: Map<string, PNode>, opts?: { full?: boolean }): StandardView {
  const root = nodes.get(rootHash);
  if (!root) {
    throw new PracticeError('E_NOT_FOUND', `node "${rootHash}" does not exist`);
  }
  const acc = buildAcc(root, nodes, 0, opts?.full === true);
  // Depth is normalized to the read root: the same subtree yields strictly equivalent views at any granularity
  const base = acc.steps.length > 0 ? Math.min(...acc.steps.map(s => s.depth)) : 0;
  const steps = acc.steps.map(s => (s.depth === base ? { ...s, depth: 0 } : { ...s, depth: s.depth - base }));
  const view: StandardView = {
    hash: computeNodeHash(root),
    type: root.type,
    name: root.name,
    description: root.description,
    license: root.license,
    metadata: root.metadata,
    content: root.content,
    steps,
    attachments: acc.attachments,
    flow: acc.flow,
    inputs: acc.inputs,
    outputs: acc.outputs,
    externalInputs: [],
    finalOutputs: [],
  };
  if (root.notice !== undefined) view.notice = root.notice;
  if (root.type === 'practice') view.op = root.op;
  if (acc.missing.length > 0) view.missing = acc.missing;
  // 对外清单：拿 flow 边对声明求差。边的 name 取自消费方的 input 名，而协议允许 input 名
  // 与它消费的 output 名不同（靠 from 的哈希连接，见 Appendix A2：boiling water → hot water）——
  // 所以先按名匹配；连线的一端只声明了一个流时，按哈希直接对应，名字不同也不会误判
  const declaredBy = (list: FlowDeclarationView[], hash: string): string[] => list.filter((d) => d.refHash === hash).map((d) => d.name);
  const supplied = new Set<string>();
  const consumed = new Set<string>();
  for (const e of acc.flow) {
    const inNames = declaredBy(acc.inputs, e.toHash);
    for (const name of inNames.length === 1 ? inNames : [e.name]) supplied.add(`${e.toHash}\u0000${name}`);
    const outNames = declaredBy(acc.outputs, e.fromHash);
    for (const name of outNames.length === 1 ? outNames : [e.name]) consumed.add(`${e.fromHash}\u0000${name}`);
  }
  view.externalInputs = acc.inputs.filter((d) => !supplied.has(`${d.refHash}\u0000${d.name}`));
  view.finalOutputs = acc.outputs.filter((d) => !consumed.has(`${d.refHash}\u0000${d.name}`));
  return view;
}

function buildAcc(node: PNode, nodes: Map<string, PNode>, depth: number, full = false): Acc {
  const nodeHash = computeNodeHash(node);
  if (node.type === 'action') {
    // Flow edges: explicitly declared from (hash addressing, no inference)
    const flow = (node.inputs ?? [])
      .filter(inp => inp.from !== undefined)
      .map(inp => ({
        name: inp.name,
        fromHash: inp.from!,
        fromName: nodes.get(inp.from!)?.name ?? inp.from!,
        toHash: nodeHash,
        toName: node.name,
      }));
    return {
      steps: [{ refHash: nodeHash, name: node.name, depth, ...(node.notice !== undefined ? { notice: node.notice } : {}), ...(full ? { content: node.content } : {}) }],
      attachments: (node.attachments ?? []).map(a => ({ ...a, refHash: nodeHash })),
      flow,
      inputs: (node.inputs ?? []).map(({ name, spec }) => ({ name, ...(spec !== undefined ? { spec } : {}), refHash: nodeHash })),
      outputs: (node.outputs ?? []).map(({ name, spec }) => ({ name, ...(spec !== undefined ? { spec } : {}), refHash: nodeHash })),
      missing: [],
    };
  }

  const acc: Acc = { steps: [], attachments: [], flow: [], inputs: [], outputs: [], missing: [] };
  for (const ref of node.children) {
    const child = nodes.get(ref.hash);
    if (!child) {
      // 读取宽容（spec §2.3 写入严格）：引用的节点文件缺失 → 占位条目 + missing 登记，
      // 视图照常产出（渲染层给出丢失卡片）；创建/编辑通道仍在入口拒绝悬空 pin
      acc.missing.push({ hash: ref.hash, parentHash: nodeHash, parentName: node.name });
      acc.steps.push({ refHash: ref.hash, name: `<missing ${ref.hash}>`, depth: depth + 1, missing: true });
      continue;
    }
    if (node.op === 'set') {
      // Set: directory view — one direct child = one entry, no recursive aggregation
      // (aggregating steps across unrelated practices is noise)
      acc.steps.push({
        refHash: ref.hash,
        name: child.name,
        depth: depth + 1,
        ...(child.description !== undefined ? { description: child.description } : {}),
      });
      continue;
    }
    const sub = buildAcc(child, nodes, depth + 1, full);
    mergeWithOp(node, sub, acc);
  }
  return acc;
}

/**
 * Aggregation semantics (spec §7):
 * - seq: steps concatenated in order; attachments deduplicated in first-seen order
 * - par: step groups annotated "parallel"
 * - choice: branches annotated "choose one"
 * - loop: subtree annotated with the repetition count
 */
function mergeWithOp(parent: PracticeNode, sub: Acc, out: Acc): void {
  const op = parent.op;

  if (sub.steps.length > 0) {
    const first = sub.steps[0];
    let note = first.note;
    if (op === 'par') note = joinNote(note, 'parallel');
    else if (op === 'choice') note = joinNote(note, 'choose one');
    else if (op === 'loop') note = joinNote(note, loopNote(parent));
    sub.steps[0] = { ...first, note };
  }
  out.steps.push(...sub.steps);

  for (const a of sub.attachments) {
    if (!out.attachments.some(existing => attachmentKey(existing) === attachmentKey(a))) out.attachments.push(a);
  }

  out.flow.push(...sub.flow);

  for (const d of sub.inputs) {
    if (!out.inputs.some(existing => declarationKey(existing) === declarationKey(d))) out.inputs.push(d);
  }
  for (const d of sub.outputs) {
    if (!out.outputs.some(existing => declarationKey(existing) === declarationKey(d))) out.outputs.push(d);
  }
}

/** Declaration dedup key: name + spec + declaring node (twins re-declare the same thing — kept once) */
function declarationKey(d: FlowDeclarationView): string {
  return `${d.name}\u0000${d.spec ?? ''}\u0000${d.refHash}`;
}
