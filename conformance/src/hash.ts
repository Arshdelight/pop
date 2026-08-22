import { createHash } from 'node:crypto';
import { isHashFormat, isRecord, type ActionNode, type PracticeNode } from './model.js';
import { PracticeError } from './errors.js';

/**
 * Lexicographic comparison over Unicode code POINTS (spec §3.1). JavaScript's
 * default sort compares UTF-16 code units, which orders astral-plane characters
 * (emoji, rare scripts) differently — a silent identity fork between a JS
 * implementation and one comparing UTF-8 bytes (byte order ≡ code point order).
 */
function compareByCodePoint(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const aRes = ai.next();
    const bRes = bi.next();
    if (aRes.done && bRes.done) return 0;
    if (aRes.done) return -1;
    if (bRes.done) return 1;
    const d = aRes.value.codePointAt(0)! - bRes.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/**
 * Stable serialization: object keys sorted, undefined values dropped, no whitespace.
 * This guarantees the canonical form of the hash input: the same semantic content
 * (regardless of key order) yields the same string.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort(compareByCodePoint);
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash input shape: a canonical node where a practice's children may be given
 * either as { hash } pins (stored/library form) or as full inline nodes
 * (document form) — both contribute the child's own hash, so the two forms
 * are interchangeable (§3.2).
 */
export type HashableNode = ActionNode | (Omit<PracticeNode, 'children'> & { children: HashableChild[] });
export type HashableChild = { hash: string } | HashableNode;

function childHash(c: HashableChild): string {
  if (isRecord(c) && 'hash' in c) {
    // A pin carries exactly one key; anything else masquerading as a pin is loud (§8).
    // Extra fields are E_SCHEMA, a malformed hash value is E_HASH_FORMAT (§6).
    const extra = Object.keys(c).filter(k => k !== 'hash');
    if (extra.length > 0) {
      throw new PracticeError('E_SCHEMA', `a child pin must carry exactly { hash } — extra fields: ${extra.join(', ')}`);
    }
    if (!isHashFormat(c.hash)) {
      throw new PracticeError('E_HASH_FORMAT', `a child pin's hash must be sha256:<64 hex>, got ${JSON.stringify(c.hash)}`);
    }
    return c.hash;
  }
  return computeNodeHash(c as HashableNode);
}

export function computeNodeHash(node: HashableNode): string {
  const payload: Record<string, unknown> = {
    type: node.type,
    name: node.name,
    content: node.content.trim(),
  };
  if (node.description !== undefined && node.description.trim() !== '') payload.description = node.description;
  if (node.license !== undefined && node.license.trim() !== '') payload.license = node.license;
  if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) payload.metadata = node.metadata;
  // Revisions are part of the content (history changes the identity chain);
  // the trigger pointer may dangle but still participates in the hash
  if (node.revisions !== undefined && node.revisions.length > 0) payload.revisions = node.revisions;
  if (node.type === 'action') {
    // Attachment pointers participate (attachments change → identity changes);
    // attachment bytes do not (blobs are content-addressed separately).
    // Each pointer contributes name/hash/mime/size only — url (§5) is stripped and does not participate
    if (node.attachments !== undefined && node.attachments.length > 0) {
      payload.attachments = node.attachments.map(({ name, hash, mime, size }) => {
        const p: Record<string, unknown> = { name, hash };
        if (mime !== undefined) p.mime = mime;
        if (size !== undefined) p.size = size;
        return p;
      });
    }
    if (node.inputs !== undefined && node.inputs.length > 0) payload.inputs = node.inputs;
    if (node.outputs !== undefined && node.outputs.length > 0) payload.outputs = node.outputs;
  } else {
    payload.op = node.op;
    // ★ Merkle: each child contributes its OWN hash — the root hash covers the
    //   whole tree (same hash ⇒ same content, everywhere, §3.3). A reference
    //   and an inline subtree of the same content contribute the same value,
    //   so the two forms are interchangeable (§1 rule 3).
    payload.children = node.children.map(childHash);
    if (node.loop !== undefined) payload.loop = node.loop;
    if (node.refines !== undefined && node.refines.trim() !== '') payload.refines = node.refines;
  }
  return `sha256:${createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')}`;
}
