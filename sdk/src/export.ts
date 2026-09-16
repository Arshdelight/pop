import type { PNode } from './model.js';
import { computeNodeHash } from './hash.js';

/**
 * Document-shape export (protocol layer): any workspace subtree → the create
 * document shape (children inlined recursively). The inverse of createFromDoc —
 * "any subtree lifted out is a legal document" is exactly this operation.
 *
 * Cycles are structurally
 * impossible (a pin is a content hash — a cycle would need a SHA-256 fixed
 * point), and DAG sharing is legal (children are addressed by hash; the same
 * hash on two paths — or twice in one children list — is just shared content,
 * there are no ids to collide). Only dangling pins are rejected here.
 *
 * inputs.from pointing outside the subtree is not checked here: referencing
 * existing workspace nodes is a legal part of create semantics; the
 * self-containment constraint belongs to the transport layer (checked there
 * when transport is implemented).
 *
 * from pins are exported as "@name" authoring sugar whenever the target node
 * is inside this subtree and the name is unambiguous (one distinct hash behind
 * it) — a hash pin would go stale the moment the referenced child's content is
 * edited, while a label re-resolves against the edited document. Targets
 * outside the subtree, and ambiguous names (same name, distinct content), keep
 * the verbatim hash pin.
 */
export function exportSubtree(node: PNode, nodes: Map<string, PNode>): Record<string, unknown> {
  const hashToName = new Map<string, string>();
  const nameHashes = new Map<string, Set<string>>();
  indexSubtree(node, nodes, hashToName, nameHashes);
  return exportNode(node, nodes, hashToName, nameHashes);
}

/** hash → name plus name → distinct hashes, over every node of the subtree (dangling pins skipped) */
function indexSubtree(
  node: PNode,
  nodes: Map<string, PNode>,
  hashToName: Map<string, string>,
  nameHashes: Map<string, Set<string>>,
): void {
  const hash = computeNodeHash(node);
  hashToName.set(hash, node.name);
  const set = nameHashes.get(node.name) ?? new Set<string>();
  set.add(hash);
  nameHashes.set(node.name, set);
  if (node.type === 'practice') {
    for (const c of node.children) {
      const child = nodes.get(c.hash);
      if (child) indexSubtree(child, nodes, hashToName, nameHashes);
    }
  }
}

function exportNode(
  node: PNode,
  nodes: Map<string, PNode>,
  hashToName: Map<string, string>,
  nameHashes: Map<string, Set<string>>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    type: node.type,
    name: node.name,
    content: node.content,
  };
  if (node.description !== undefined) doc.description = node.description;
  if (node.license !== undefined) doc.license = node.license;
  if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) doc.metadata = node.metadata;
  if (node.revisions !== undefined && node.revisions.length > 0) doc.revisions = node.revisions;
  if (node.type === 'action') {
    if (node.attachments !== undefined && node.attachments.length > 0) doc.attachments = node.attachments;
    if (node.inputs !== undefined && node.inputs.length > 0) {
      doc.inputs = node.inputs.map((inp) => {
        if (inp.from === undefined) return inp;
        const target = hashToName.get(inp.from);
        if (target === undefined) return inp; // outside this subtree — keep the verbatim pin
        const distinct = nameHashes.get(target)!;
        return distinct.size > 1 ? inp : { ...inp, from: `@${target}` };
      });
    }
    if (node.outputs !== undefined && node.outputs.length > 0) doc.outputs = node.outputs;
  } else {
    doc.op = node.op;
    if (node.loop !== undefined) doc.loop = node.loop;
    if (node.refines !== undefined) doc.refines = node.refines;
    doc.children = node.children.map((ref) => {
      const child = nodes.get(ref.hash);
      // 读取宽容：引用的节点缺失时按 pin 原样导出（{ hash } 是文档合法形态）——
      // 它无法内联展开，但导出物忠实于存储真相；重新导入会撞 E_DANGLING（写入严格）
      if (!child) return { hash: ref.hash };
      return exportNode(child, nodes, hashToName, nameHashes);
    });
  }
  return doc;
}
