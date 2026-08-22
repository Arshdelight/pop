import { PracticeError } from './errors.js';
import type { PNode } from './model.js';

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
 */
export function exportSubtree(node: PNode, nodes: Map<string, PNode>): Record<string, unknown> {
  return exportNode(node, nodes);
}

function exportNode(node: PNode, nodes: Map<string, PNode>): Record<string, unknown> {
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
    if (node.inputs !== undefined && node.inputs.length > 0) doc.inputs = node.inputs;
    if (node.outputs !== undefined && node.outputs.length > 0) doc.outputs = node.outputs;
  } else {
    doc.op = node.op;
    if (node.loop !== undefined) doc.loop = node.loop;
    if (node.refines !== undefined) doc.refines = node.refines;
    doc.children = node.children.map((ref) => {
      const child = nodes.get(ref.hash);
      if (!child) {
        throw new PracticeError('E_DANGLING', `references a nonexistent child "${ref.hash}"`, {
          hint: 'fix dangling references first (validate locates them)',
        });
      }
      return exportNode(child, nodes);
    });
  }
  return doc;
}
