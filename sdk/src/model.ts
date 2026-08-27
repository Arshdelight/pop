import { PracticeError } from './errors.js';

export type Op = 'seq' | 'par' | 'choice' | 'loop' | 'set';
export const OPS: readonly Op[] = ['seq', 'par', 'choice', 'loop', 'set'];

/**
 * Attachment: content-addressed blob pointer (action leaves only).
 * Bytes live in blobs/<first 2 hex>/<hex> outside the node file — the tree
 * stays lightweight; attachment identity is carried by the hash:
 * changed bytes → changed hash → changed pointer → changed node identity.
 */
export interface Attachment {
  name: string;
  /** sha256 of the attachment bytes (sha256:<64 hex>), same format as a node hash */
  hash: string;
  /** Display hint (e.g. image/png); not enforced by the protocol */
  mime?: string;
  /** Byte count, for display and pre-checks */
  size?: number;
  /** Optional external fetch path (http/https): bytes are hosted outside the blob channel; does NOT participate in the node hash — verification is by `hash` (fetch → recompute sha256 → compare) */
  url?: string;
}

/** Flow entry: input = consumed (from names the producing node by hash), output = produced */
export interface FlowItem {
  name: string;
  /** Spec, human-readable, never used in matching */
  spec?: string;
  /** Inputs only: the producing node's hash; absent means it is prepared externally */
  from?: string;
}

/** ChildRef (§2.3): a pinned reference to an already-stored POP — the hash is the whole address */
export interface ChildRef {
  hash: string;
}

/**
 * Revision record: the timeline in the format. The structure is acyclic,
 * time is directed — trigger is a history pointer (to the node that caused
 * the revision), not a containment edge; it may dangle and is never validated.
 */
export interface Revision {
  when: string;
  what: string;
  /** Content hash of the node before this revision (the overwritten version remains nameable) */
  from?: string;
  /** The node hash that triggered this revision (the "back edge" of exploratory practices) */
  trigger?: string;
}

export interface CountLoop {
  mode: 'count';
  count: number;
}

/** The until predicate is natural language, never evaluated — the protocol is a document format; judgment rests with humans/agents (same level as flow specs) */
export interface UntilLoop {
  mode: 'until';
  until: string;
}

export type LoopConfig = CountLoop | UntilLoop;

export interface ActionNode {
  type: 'action';
  /** Human-readable label — also the only name a node has; renaming changes identity (name is content) */
  name: string;
  description?: string;
  content: string;
  /** Reuse terms: license name or a bundled license file reference */
  license?: string;
  /** Extension bag: vendor-specific properties the spec does not define (keys should be x-<vendor>-<name>) */
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
  inputs?: FlowItem[];
  outputs?: FlowItem[];
  revisions?: Revision[];
}

export interface PracticeNode {
  type: 'practice';
  name: string;
  description?: string;
  content: string;
  license?: string;
  metadata?: Record<string, unknown>;
  op: Op;
  /** Containment pins: each child addressed by its own node hash (the pin is the address — content addressing) */
  children: ChildRef[];
  loop?: LoopConfig;
  /** Which action this practice refines, by hash (recorded on refine; may dangle) */
  refines?: string;
  revisions?: Revision[];
}

export type PNode = ActionNode | PracticeNode;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Frontmatter top-level field → file line number (1-based). fmText is the raw
 * YAML text without the --- fences; its line i (0-based) maps to file line
 * i+2 (line 1 is the fence). No line number when the field is not found — never guess.
 */
function lineOf(fmText: string | undefined, field: string): number | undefined {
  if (fmText === undefined) return undefined;
  const idx = fmText.split('\n').findIndex(l => l.startsWith(`${field}:`));
  return idx === -1 ? undefined : idx + 2;
}

function schemaErr(message: string, fmText: string | undefined, field: string): PracticeError {
  const line = lineOf(fmText, field);
  return new PracticeError('E_SCHEMA', message, line === undefined ? undefined : { line });
}

/** E_OP/E_LOOP carry line info like schema errors but their own codes (§6) */
function codedErr(code: string, message: string, fmText: string | undefined, field: string): PracticeError {
  const line = lineOf(fmText, field);
  return new PracticeError(code, message, line === undefined ? undefined : { line });
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new PracticeError('E_SCHEMA', `${field} must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * A field that is present but has the wrong JSON type is an error, never a
 * silent drop (§8: dropped fields fork hashes; a wrong-typed value the author
 * wrote must not quietly vanish from the hashed document). Empty/whitespace-only
 * string stays ≡ absent (§1 rule 2). No coercion: converting numbers to strings
 * would bake a cross-language-unstable transformation into identity.
 */
export function presentString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new PracticeError('E_SCHEMA', `${field} must be a string when present (got ${Array.isArray(v) ? 'array' : typeof v})`);
  }
  return v.trim() === '' ? undefined : v;
}

/** §3.2 "sha256:" + 64 hex — the address prefix and its full-form grammar */
export const HASH_PREFIX = "sha256:";
export const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Resource guards (spec §6: implementation policy, like blob size §5). Recursion
 * is how every layer walks trees and JSON values, so unbounded nesting would
 * surface as a stack RangeError instead of a typed error — beyond these limits
 * the document is refused with E_SCHEMA, never silently truncated.
 */
export const MAX_NODE_DEPTH = 100;
export const MAX_JSON_DEPTH = 100;

export function isHashFormat(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v);
}

/**
 * JSON citizenship (§2.1: metadata values are JSON). Returns a description of
 * the first violation, or undefined. YAML natives — unquoted dates parsed into
 * Date objects, .nan/.inf into NaN/Infinity — are NOT JSON and must be rejected
 * here: the canonical serializer would silently collapse them (a Date hashes
 * as {}, NaN as null), breaking "same hash ⇒ same content".
 */
export function jsonValueViolation(v: unknown, where: string, depth = 0): string | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return `${where}: nesting exceeds ${MAX_JSON_DEPTH} levels — too deeply nested to hash (refused, spec §6)`;
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? undefined : `${where}: non-finite number (.nan/.inf are not JSON — quote them as strings)`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = jsonValueViolation(v[i], `${where}[${i}]`, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof v === 'object') {
    // Only plain objects are JSON — a Date (unquoted YAML date) has no enumerable
    // properties and would otherwise pass as "empty object", collapsing in the hash
    const ctor = (v as object).constructor;
    if (ctor !== undefined && ctor !== Object) {
      return `${where}: a ${ctor.name} is not a JSON value — quote date-like strings`;
    }
    for (const [k, val] of Object.entries(v)) {
      const r = jsonValueViolation(val, `${where}.${k}`, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  return `${where}: ${typeof v} is not a JSON value (quote date-like strings)`;
}

export function parseAttachmentItem(item: unknown, prefix = 'attachments'): Attachment {
  if (!isRecord(item)) throw new PracticeError('E_SCHEMA', `${prefix} items must be objects`);
  rejectUnknownKeys(item, ['name', 'hash', 'mime', 'size', 'url'], prefix);
  const name = requireString(item.name, `${prefix}.name`);
  if (!isHashFormat(item.hash)) {
    throw new PracticeError('E_SCHEMA', `${prefix}["${name}"].hash must be sha256:<64 hex>`);
  }
  if (item.size !== undefined && (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 0)) {
    throw new PracticeError('E_SCHEMA', `${prefix}["${name}"].size must be a non-negative integer (bytes)`);
  }
  const a: Attachment = { name, hash: item.hash };
  const mime = presentString(item.mime, `${prefix}["${name}"].mime`);
  if (mime !== undefined) a.mime = mime;
  if (item.size !== undefined) a.size = item.size;
  if (item.url !== undefined) {
    // No trimming: urls are preserved verbatim (§5.1) — edge whitespace fails validation instead of being rewritten
    if (typeof item.url !== 'string' || !/^https?:\/\/\S+$/i.test(item.url)) {
      throw new PracticeError('E_SCHEMA', `${prefix}["${name}"].url must be an http(s) URL`);
    }
    a.url = item.url;
  }
  return a;
}

/** §8: an implementation must reject fields it does not recognize — silently dropping them forks hashes */
export function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new PracticeError('E_SCHEMA', `${what}: unknown field "${k}" (allowed: ${allowed.join(', ')})`, {
        hint: 'spec §8: unrecognized fields must be rejected, not dropped — dropped fields fork hashes',
      });
    }
  }
}

function parseAttachments(v: unknown, fmText?: string): Attachment[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw schemaErr('attachments must be an array', fmText, 'attachments');
  return v.map((item, i) => parseAttachmentItem(item, `attachments[${i}]`));
}

/**
 * Inline media references (spec §5.1): ![caption](attachment-name) inside content.
 * Names resolve against this node's attachment list (node-local, unique per node);
 * bytes always travel via the blob channel. Fenced code blocks are not prose —
 * their contents are never scanned; inline code spans (`…`) are code the same way
 * (documentation showing the media syntax itself must not be treated as a reference).
 * An empty target `![]()` matches nothing and is reported (E_MEDIA_REF at the
 * caller) rather than silently skipped.
 */
export function extractMediaRefs(content: string): string[] {
  return [...content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .matchAll(/!\[[^\]]*\]\(([^)]*)\)/g)].map(m => m[1]);
}

/** Stored-form children: every entry is a {hash} pin (inline children exist only in documents, §1) */
function parseChildren(v: unknown, fmText?: string): ChildRef[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw schemaErr('children must be a non-empty array of { hash } pins', fmText, 'children');
  }
  return v.map((item, i) => {
    if (!isRecord(item)) throw new PracticeError('E_SCHEMA', `children[${i}] must be { hash } objects`);
    rejectUnknownKeys(item, ['hash'], `children[${i}]`);
    if (!isHashFormat(item.hash)) {
      throw new PracticeError('E_HASH_FORMAT', `children[${i}].hash must be sha256:<64 hex>`);
    }
    return { hash: item.hash };
  });
}

export function parseFlowItem(item: unknown, kind: 'inputs' | 'outputs', i: number): FlowItem {
  if (!isRecord(item)) throw new PracticeError('E_SCHEMA', `${kind}[${i}] must be objects`);
  rejectUnknownKeys(item, ['name', 'spec', 'from'], `${kind}[${i}]`);
  const name = requireString(item.name, `${kind}[${i}].name`);
  const spec = presentString(item.spec, `${kind}[${i}].spec`);
  const from = presentString(item.from, `${kind}[${i}].from`);
  if (kind === 'outputs' && from !== undefined) {
    throw new PracticeError('E_SCHEMA', `outputs[${i}] must not carry from (only inputs declare a source)`);
  }
  if (from !== undefined && !isHashFormat(from)) {
    throw new PracticeError('E_HASH_FORMAT', `${kind}[${i}].from must be a node hash (sha256:<64 hex>) — "@name" labels are document-form authoring sugar, resolved before storage`);
  }
  const f: FlowItem = { name };
  if (spec !== undefined) f.spec = spec;
  if (from !== undefined) f.from = from;
  return f;
}

function parseFlowList(v: unknown, kind: 'inputs' | 'outputs', fmText?: string): FlowItem[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw schemaErr(`${kind} must be an array`, fmText, kind);
  return v.map((item, i) => parseFlowItem(item, kind, i));
}

function parseLoop(v: unknown, fmText?: string): LoopConfig | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw codedErr('E_LOOP', 'loop must be { mode: count, count } or { mode: until, until }', fmText, 'loop');
  if (v.mode === 'until') {
    rejectUnknownKeys(v, ['mode', 'until'], 'loop');
    const until = presentString(v.until, 'loop.until');
    if (until === undefined) throw codedErr('E_LOOP', 'an until loop requires a non-empty until predicate', fmText, 'loop');
    return { mode: 'until', until };
  }
  // Unknown keys are rejected before the value checks — same order as the document channel (§8 first)
  rejectUnknownKeys(v, ['mode', 'count'], 'loop');
  if (v.mode !== 'count' || !Number.isInteger(v.count) || (v.count as number) < 1) {
    throw codedErr('E_LOOP', 'a count loop must be { mode: count, count: integer ≥1 }', fmText, 'loop');
  }
  return { mode: 'count', count: v.count as number };
}

/** Extension bag: vendor-specific properties the spec does not define (keys should be x-<vendor>-<name>); values are arbitrary JSON (lists/objects included — they participate in the hash via the recursive canonical serialization); empty object ≡ absent */
function parseMetadata(v: unknown, fmText?: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw schemaErr('metadata must be an object', fmText, 'metadata');
  for (const [k, val] of Object.entries(v)) {
    const violation = jsonValueViolation(val, `metadata["${k}"]`);
    if (violation !== undefined) throw schemaErr(violation, fmText, 'metadata');
  }
  return v as Record<string, unknown>;
}

export function parseRevisions(v: unknown): Revision[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new PracticeError('E_SCHEMA', 'revisions must be an array');
  return v.map((item, i) => {
    if (!isRecord(item)) throw new PracticeError('E_SCHEMA', `revisions[${i}] must be objects`);
    rejectUnknownKeys(item, ['when', 'what', 'from', 'trigger'], `revisions[${i}]`);
    const when = requireString(item.when, `revisions[${i}].when`);
    const what = requireString(item.what, `revisions[${i}].what`);
    const rev: Revision = { when, what };
    const from = presentString(item.from, `revisions[${i}].from`);
    const trigger = presentString(item.trigger, `revisions[${i}].trigger`);
    if (from !== undefined) rev.from = from;
    if (trigger !== undefined) rev.trigger = trigger;
    return rev;
  });
}

const NODE_FIELDS = [
  'type', 'name', 'description', 'license', 'metadata', 'revisions',
  'attachments', 'inputs', 'outputs', 'op', 'children', 'loop', 'refines',
] as const;

/**
 * Parse a stored node from frontmatter data + markdown body. The stored form
 * pins children by hash (§2.3); a node file's name is its content hash
 * (reconciled by the store on load). `name` is required — it is the only
 * label a node carries.
 */
export function parseNodeFromMatter(data: Record<string, unknown>, content: string, fmText?: string): PNode {
  rejectUnknownKeys(data, NODE_FIELDS, 'node');
  const name = requireString(data.name, 'name');
  const description = presentString(data.description, 'description');
  const license = presentString(data.license, 'license');
  const metadata = parseMetadata(data.metadata, fmText);

  if (data.type === 'action') {
    if (data.children !== undefined) throw schemaErr('action must not carry children', fmText, 'children');
    if (data.op !== undefined) throw schemaErr('action must not carry op', fmText, 'op');
    if (data.loop !== undefined) throw schemaErr('action must not carry loop', fmText, 'loop');
    if (data.refines !== undefined) throw schemaErr('refines belongs to practices only', fmText, 'refines');
    const inputs = parseFlowList(data.inputs, 'inputs', fmText);
    const outputs = parseFlowList(data.outputs, 'outputs', fmText);
    const node: ActionNode = {
      type: 'action',
      name,
      description,
      content,
    };
    if (license !== undefined) node.license = license;
    if (metadata !== undefined && Object.keys(metadata).length > 0) node.metadata = metadata;
    if (inputs.length > 0) node.inputs = inputs;
    if (outputs.length > 0) node.outputs = outputs;
    const attachments = parseAttachments(data.attachments, fmText);
    if (attachments !== undefined && attachments.length > 0) node.attachments = attachments;
    const actionRevisions = parseRevisions(data.revisions);
    if (actionRevisions !== undefined && actionRevisions.length > 0) node.revisions = actionRevisions;
    return node;
  }

  if (data.type === 'practice') {
    if (data.inputs !== undefined) {
      throw schemaErr('inputs on a practice is a derived view; hand-written values are rejected', fmText, 'inputs');
    }
    if (data.outputs !== undefined) {
      throw schemaErr('outputs on a practice is a derived view; hand-written values are rejected', fmText, 'outputs');
    }
    if (data.attachments !== undefined) {
      throw schemaErr('attachments on a practice is a derived view; hand-written values are rejected (attachments live on action leaves only)', fmText, 'attachments');
    }
    const op = data.op;
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
      throw codedErr('E_OP', `op must be one of ${OPS.join(' / ')}`, fmText, 'op');
    }
    if (data.loop !== undefined && op !== 'loop') {
      throw codedErr('E_LOOP', 'loop config is only allowed with op=loop', fmText, 'loop');
    }
    const node: PracticeNode = {
      type: 'practice',
      name,
      description,
      content,
      op: op as Op,
      children: parseChildren(data.children, fmText),
      loop: parseLoop(data.loop, fmText),
      refines: presentString(data.refines, 'refines'),
    };
    if (license !== undefined) node.license = license;
    if (metadata !== undefined && Object.keys(metadata).length > 0) node.metadata = metadata;
    const practiceRevisions = parseRevisions(data.revisions);
    if (practiceRevisions !== undefined && practiceRevisions.length > 0) node.revisions = practiceRevisions;
    return node;
  }

  throw schemaErr(`type must be "action" or "practice", got ${JSON.stringify(data.type)}`, fmText, 'type');
}
