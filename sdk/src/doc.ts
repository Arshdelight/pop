import { PracticeError } from './errors.js';
import { computeNodeHash } from './hash.js';
import {
  OPS, extractMediaRefs, isHashFormat, isRecord, jsonValueViolation, parseAttachmentItem, parseRevisions, presentString,
  rejectUnknownKeys,
  type ActionNode, type Attachment, type FlowItem, type LoopConfig, type Op,
  type PNode, type PracticeNode, type Revision,
} from './model.js';
import type { Workspace } from './store.js';
import { saveNode } from './store.js';

/** Document-form node fields (§1/§2). Anything else is rejected, not dropped (§8). */
const NODE_FIELDS = [
  'name', 'type', 'description', 'license', 'metadata', 'content', 'revisions',
  'attachments', 'inputs', 'outputs', 'children', 'op', 'loop', 'refines',
] as const;

/** A planned (parsed, not yet built) node — the transient form of document import */
export interface Planned {
  path: string;
  name: string;
  description?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  content: string;
  isPractice: boolean;
  op: Op;
  loop?: LoopConfig;
  refines?: string;
  children: ChildEntry[];
  attachments: Attachment[];
  inputs: FlowItem[];
  outputs: FlowItem[];
  revisions?: Revision[];
}

/**
 * A children entry: a ChildRef (`{ hash }`, §2.3) pins an already-stored POP
 * by its own hash; an object is an inlined subtree.
 */
export type ChildEntry = { kind: 'inline'; node: Planned } | { kind: 'ref'; hash: string };

export interface PlanCtx {
  ws: Workspace;
}

export function failDoc(nodePath: string, message: string, hint?: string): never {
  throw new PracticeError('E_SCHEMA', `${nodePath}: ${message}`, { hint });
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function parseAttachmentsField(v: unknown, nodePath: string): Attachment[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) failDoc(`${nodePath}.attachments`, 'must be an array');
  const seen = new Set<string>();
  return v.map((item, i) => {
    const p = `${nodePath}.attachments[${i}]`;
    if (!isRecord(item)) failDoc(p, 'must be { name, hash, mime?, size?, url? } objects');
    const a = parseAttachmentItem(item, `${nodePath}.attachments[${i}]`);
    // Inline media references resolve by name (spec §5.1): names must be unique per node
    if (seen.has(a.name)) failDoc(`${p}.name`, `attachment name "${a.name}" is duplicated within this node (content references attachments by name)`);
    seen.add(a.name);
    return a;
  });
}

function parseMetadataField(v: unknown, nodePath: string): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) failDoc(`${nodePath}.metadata`, 'must be an object (values are arbitrary JSON, §2.1)');
  for (const [k, val] of Object.entries(v)) {
    const violation = jsonValueViolation(val, `${nodePath}.metadata["${k}"]`);
    if (violation !== undefined) {
      failDoc(nodePath, violation, 'metadata values must be JSON — strings, finite numbers, booleans, null, arrays, objects (quote date-like strings)');
    }
  }
  return v;
}

function parseRevisionsField(v: unknown, nodePath: string): Revision[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) failDoc(`${nodePath}.revisions`, 'must be an array');
  const revs = parseRevisions(v);
  if (revs !== undefined && revs.length === 0) return undefined; // empty ≡ absent
  return revs;
}

function parseFlowField(v: unknown, kind: 'inputs' | 'outputs', nodePath: string): FlowItem[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) failDoc(`${nodePath}.${kind}`, 'must be an array');
  return v.map((item, i) => {
    if (!isRecord(item)) failDoc(`${nodePath}.${kind}[${i}]`, 'must be objects');
    rejectUnknownKeys(item, ['name', 'spec', 'from'], `${nodePath}.${kind}[${i}]`);
    const name = optionalString(item.name);
    if (name === undefined) failDoc(`${nodePath}.${kind}[${i}].name`, 'must be a non-empty string');
    const spec = presentString(item.spec, `${nodePath}.${kind}[${i}].spec`);
    const from = presentString(item.from, `${nodePath}.${kind}[${i}].from`);
    if (kind === 'outputs' && from !== undefined) {
      failDoc(`${nodePath}.${kind}[${i}]`, 'outputs must not carry from (only inputs declare a source)');
    }
    if (from !== undefined && !from.startsWith('@') && !isHashFormat(from)) {
      throw new PracticeError(
        'E_HASH_FORMAT',
        `${nodePath}.${kind}[${i}].from must be a node hash (sha256:<64 hex>) or an "@name" label (document-form authoring sugar, §1 rule 4)`,
      );
    }
    const f: FlowItem = { name };
    if (spec !== undefined) f.spec = spec;
    if (from !== undefined) f.from = from;
    return f;
  });
}

/**
 * Parse a document node (recursive). children present → practice, absent → action;
 * a children entry is a ChildRef `{ hash }` (pinned reference to an already-stored
 * POP, §2.3) or an object (an inlined same-shaped node). Unrecognized fields are
 * rejected, never dropped (§8).
 */
export function plan(ctx: PlanCtx, raw: unknown, nodePath: string): Planned {
  if (!isRecord(raw)) failDoc(nodePath, 'a node must be a JSON object');
  rejectUnknownKeys(raw, NODE_FIELDS, nodePath);
  const name = optionalString(raw.name);
  if (name === undefined) failDoc(`${nodePath}.name`, 'must be a non-empty string (name is the only label a node carries)');
  if (raw.type !== undefined && typeof raw.type !== 'string') {
    failDoc(`${nodePath}.type`, `must be a string when present (got ${typeof raw.type})`);
  }
  const description = presentString(raw.description, `${nodePath}.description`);
  const license = presentString(raw.license, `${nodePath}.license`);
  const metadata = parseMetadataField(raw.metadata, nodePath);
  const content = presentString(raw.content, `${nodePath}.content`) ?? '';
  const revisions = parseRevisionsField(raw.revisions, nodePath);

  if (raw.children === undefined) {
    const explicit = optionalString(raw.type);
    if (explicit !== undefined && explicit !== 'action') {
      failDoc(`${nodePath}.type`, `"${explicit}" disagrees with the inference (no children means action)`);
    }
    if (raw.op !== undefined) failDoc(`${nodePath}.op`, 'action must not carry op (no children means action)');
    if (raw.loop !== undefined) failDoc(`${nodePath}.loop`, 'action must not carry loop');
    if (raw.refines !== undefined) failDoc(`${nodePath}.refines`, 'refines belongs to practices only (actions have no containment)');
    return {
      path: nodePath,
      name,
      description,
      license,
      metadata,
      content,
      isPractice: false,
      op: 'seq',
      children: [],
      attachments: parseAttachmentsField(raw.attachments, nodePath),
      inputs: parseFlowField(raw.inputs, 'inputs', nodePath),
      outputs: parseFlowField(raw.outputs, 'outputs', nodePath),
      revisions,
    };
  }

  const explicit = optionalString(raw.type);
  if (explicit !== undefined && explicit !== 'practice') {
    failDoc(`${nodePath}.type`, `"${explicit}" disagrees with the inference (children means practice)`);
  }
  for (const f of ['attachments', 'inputs', 'outputs'] as const) {
    if (raw[f] !== undefined) failDoc(`${nodePath}.${f}`, 'attachments/inputs/outputs may appear on leaf actions only');
  }
  if (!Array.isArray(raw.children) || raw.children.length === 0) {
    failDoc(`${nodePath}.children`, 'a practice must have at least one child');
  }
  const op = raw.op === undefined ? 'seq' : raw.op;
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
    throw new PracticeError('E_OP', `${nodePath}.op: op must be one of ${OPS.join(' / ')}`);
  }
  let loop: LoopConfig | undefined;
  if (raw.loop !== undefined) {
    if (op !== 'loop') {
      throw new PracticeError('E_LOOP', `${nodePath}.loop: loop config is only allowed with op=loop`);
    }
    if (!isRecord(raw.loop) || (raw.loop.mode !== 'count' && raw.loop.mode !== 'until')) {
      throw new PracticeError('E_LOOP', `${nodePath}.loop: must be { "mode": "count", "count": integer ≥1 } or { "mode": "until", "until": "predicate" }`);
    }
    // A loop config carries exactly the keys its mode defines (§8) — count on an
    // until-loop is not a silent no-op cap, it is rejected
    rejectUnknownKeys(raw.loop, raw.loop.mode === 'until' ? ['mode', 'until'] : ['mode', 'count'], `${nodePath}.loop`);
    if (raw.loop.mode === 'until') {
      if (typeof raw.loop.until !== 'string' || raw.loop.until.trim() === '') {
        throw new PracticeError('E_LOOP', `${nodePath}.loop.until: an until loop requires a non-empty until predicate`);
      }
      // 存原样：content 是唯一被改写的字段（spec §3.2），trim until 会分叉身份
      loop = { mode: 'until', until: raw.loop.until };
    } else if (Number.isInteger(raw.loop.count) && (raw.loop.count as number) >= 1) {
      loop = { mode: 'count', count: raw.loop.count as number };
    } else {
      throw new PracticeError('E_LOOP', `${nodePath}.loop.count: a count loop requires an integer ≥1`);
    }
  }
  return {
    path: nodePath,
    name,
    description,
    license,
    metadata,
    content,
    isPractice: true,
    op: op as Op,
    loop,
    // History pointer: may target nodes outside the document/workspace; preserved verbatim (dangling-tolerant, like the store layer)
    refines: presentString(raw.refines, `${nodePath}.refines`),
    children: raw.children.map((c: unknown, i: number) => {
      const childPath = `${nodePath}.children[${i}]`;
      if (typeof c === 'string') {
        failDoc(childPath, 'a children entry must be an inline node object or a { hash } reference — bare strings are not a legal form (nodes are addressed by hash only, §3)');
      }
      if (!isRecord(c)) failDoc(childPath, 'a children entry must be an inline node object or a { hash } reference');
      if ('hash' in c) {
        // ChildRef (§2.3): a pinned reference to an already-stored POP — resolved by hash
        const extra = Object.keys(c).filter(k => k !== 'hash');
        if (extra.length > 0) failDoc(childPath, `a ChildRef may only carry hash, found: ${extra.join(', ')}`);
        if (!isHashFormat(c.hash)) {
          throw new PracticeError('E_HASH_FORMAT', `${childPath}: hash must be sha256:<64 hex>`, {
            hint: 'a ChildRef pins the referenced document\'s root hash — the whole address',
          });
        }
        if (!ctx.ws.nodes.has(c.hash)) {
          throw new PracticeError('E_DANGLING', `${childPath}: ChildRef references "${c.hash}", which is not stored in the workspace`, {
            hint: 'a ChildRef must point at content already stored (upload the child first)',
          });
        }
        return { kind: 'ref', hash: c.hash } as ChildEntry;
      }
      return { kind: 'inline', node: plan(ctx, c, childPath) } as ChildEntry;
    }),
    attachments: [],
    inputs: [],
    outputs: [],
    revisions,
  };
}

/**
 * Inline media reference validation (spec §5.1): ![caption](attachment-name)
 * in action content must hit this node's attachment list. Same treatment as
 * from — rejected at import; practices carry no attachment list, so they are skipped.
 */
function resolveMediaRefs(p: Planned): void {
  if (!p.isPractice) {
    const names = new Set(p.attachments.map(a => a.name));
    for (const ref of extractMediaRefs(p.content)) {
      // http(s) URL targets are valid external references (§5.1) — best-effort, not validated
      if (/^https?:\/\//i.test(ref)) continue;
      if (!names.has(ref)) {
        throw new PracticeError(
          'E_MEDIA_REF',
          `${p.path}.content: media reference "![](…)" names "${ref}", which is not in this node's attachments`,
          { hint: 'inline references resolve by name against this node\'s attachments; http(s) URL targets are valid external references and are exempt', },
        );
      }
    }
  }
  for (const c of p.children) {
    if (c.kind === 'inline') resolveMediaRefs(c.node);
  }
}

/**
 * Build PNodes from a Planned tree (pure — nothing is persisted here). Returns
 * the built node plus its content hash; the parent pins each child's hash
 * (inline children are built bottom-up, so a document's root hash covers the
 * whole tree — §3.2). The persistence semantics of every protocol field live
 * here and here only — shared by all edit channels to prevent divergence.
 */
export function buildPlannedNode(p: Planned): { node: PNode; hash: string } {
  const cached = buildCache.get(p);
  if (cached !== undefined) return cached;
  let node: PNode;
  if (!p.isPractice) {
    const action: ActionNode = {
      type: 'action',
      name: p.name,
      description: p.description,
      content: p.content,
    };
    if (p.license !== undefined) action.license = p.license;
    if (p.metadata !== undefined && Object.keys(p.metadata).length > 0) action.metadata = p.metadata;
    if (p.attachments.length > 0) action.attachments = p.attachments;
    if (p.inputs.length > 0) action.inputs = p.inputs;
    if (p.outputs.length > 0) action.outputs = p.outputs;
    if (p.revisions !== undefined && p.revisions.length > 0) action.revisions = p.revisions;
    node = action;
  } else {
    const children = p.children.map(entry =>
      entry.kind === 'ref' ? { hash: entry.hash } : { hash: buildPlannedNode(entry.node).hash },
    );
    const practice: PracticeNode = {
      type: 'practice',
      name: p.name,
      description: p.description,
      content: p.content,
      op: p.op,
      children,
    };
    if (p.license !== undefined) practice.license = p.license;
    if (p.metadata !== undefined && Object.keys(p.metadata).length > 0) practice.metadata = p.metadata;
    if (p.loop !== undefined) practice.loop = p.loop;
    if (p.refines !== undefined) practice.refines = p.refines;
    if (p.revisions !== undefined && p.revisions.length > 0) practice.revisions = p.revisions;
    node = practice;
  }
  const result = { node, hash: computeNodeHash(node) };
  buildCache.set(p, result);
  return result;
}

/**
 * Build memoization (§3.4): each Planned node is built and hashed exactly once,
 * making the whole import pipeline — label resolution, hash collection,
 * persistence — a single bottom-up pass over the tree instead of re-building
 * every subtree at each stage.
 */
const buildCache = new WeakMap<Planned, { node: PNode; hash: string }>();

/** Collect the hashes of every node a planned tree will produce (inline-built and referenced alike) */
function collectHashes(p: Planned, into: Set<string>): void {
  const { hash } = buildPlannedNode(p);
  into.add(hash);
  for (const c of p.children) {
    if (c.kind === 'inline') collectHashes(c.node, into);
    else into.add(c.hash);
  }
}

/** Document-form from-labels: name → planned nodes (twins may legally share a name) */
function indexNames(p: Planned, index: Map<string, Planned[]>): void {
  const list = index.get(p.name) ?? [];
  list.push(p);
  index.set(p.name, list);
  for (const c of p.children) {
    if (c.kind === 'inline') indexNames(c.node, index);
  }
}

/**
 * Resolve document-form from-labels ("@name", §1 rule 4) into node hashes —
 * bottom-up, before anything is hashed or persisted. Labels are authoring
 * sugar only: the stored form always carries hashes. A label must name exactly
 * one distinct node (twins — same name, same content, same hash — resolve
 * fine); a label chain that closes a loop is a dataflow cycle and is rejected.
 */
function resolveLabels(
  p: Planned,
  index: Map<string, Planned[]>,
  resolving: Set<Planned>,
): void {
  if (resolving.has(p)) {
    failDoc(p.path, 'from-label cycle: this node (or one of its ancestors) is reachable from its own from-label', 'a from may not point at a node that contains it — restructure the dataflow');
  }
  resolving.add(p);
  for (const c of p.children) {
    if (c.kind === 'inline') resolveLabels(c.node, index, resolving);
  }
  for (const inp of p.inputs) {
    if (inp.from !== undefined && inp.from.startsWith('@')) {
      const label = inp.from.slice(1);
      const candidates = index.get(label) ?? [];
      if (candidates.length === 0) {
        failDoc(p.path, `from-label "@${label}" names no node in this document`, 'write a name that exists in this document, or the full node hash');
      }
      const hashes = [...new Set(candidates.map(c => {
        resolveLabels(c, index, resolving);
        return buildPlannedNode(c).hash;
      }))];
      if (hashes.length > 1) {
        failDoc(p.path, `from-label "@${label}" is ambiguous: ${hashes.length} distinct nodes carry this name`, 'rename one of them, or reference it by its full hash');
      }
      inp.from = hashes[0];
    }
  }
  resolving.delete(p);
  // Memoized build: the node's inputs are final now, so its hash is final (§3.4)
  buildPlannedNode(p);
}

/**
 * inputs.from addresses a node by hash (§2.2): it must name a node of this
 * document (inline or referenced) or any node already stored in the workspace
 * (the importing library is a legal source, §1 rule 4).
 */
function resolveFroms(p: Planned, docHashes: Set<string>, ws: Workspace): void {
  for (const inp of p.inputs) {
    if (inp.from !== undefined && !docHashes.has(inp.from) && !ws.nodes.has(inp.from)) {
      throw new PracticeError(
        'E_FLOW_FROM',
        `${p.path}: input "${inp.name}" references a nonexistent node "${inp.from}" in from`,
        { hint: 'from must carry the hash of a node inside the document, or of an existing workspace node' },
      );
    }
  }
  for (const c of p.children) {
    if (c.kind === 'inline') resolveFroms(c.node, docHashes, ws);
  }
}

/** Persist a built tree; the parent is saved first, then inline children — order is irrelevant, each node is an independent content-addressed file */
function persistTree(root: string, p: Planned, created: string[]): PNode {
  const { node, hash } = buildPlannedNode(p);
  saveNode(root, node); // recomputes the hash internally — same value, idempotent write
  created.push(hash);
  for (const c of p.children) {
    if (c.kind === 'inline') persistTree(root, c.node, created);
  }
  return node;
}

/**
 * Import a document: parse → validate → build → persist; the whole tree lands
 * in the workspace, each node under its own hash. Returns the root hash and
 * the hashes of all created nodes.
 */
export function createFromDoc(ws: Workspace, doc: unknown): { root: string; created: string[]; count: number } {
  const ctx: PlanCtx = { ws };
  const root = plan(ctx, doc, '$');

  resolveMediaRefs(root);

  // Authoring sugar first: labels become hashes before anything is hashed or persisted
  const nameIndex = new Map<string, Planned[]>();
  indexNames(root, nameIndex);
  resolveLabels(root, nameIndex, new Set());

  const docHashes = new Set<string>();
  collectHashes(root, docHashes);
  resolveFroms(root, docHashes, ws);

  const created: string[] = [];
  const rootNode = persistTree(ws.root, root, created);
  return { root: computeNodeHash(rootNode), created, count: created.length };
}

/**
 * Pure import (no persistence): parse → validate → build, returning the tree,
 * its Merkle root hash, and every node's hash → node. For transports that keep
 * their own store (a hub), the document is imported without touching the
 * content-addressed workspace.
 *
 * Two transport-layer differences from createFromDoc:
 * - ChildRefs are E_DANGLING — the importing transport resolves them first
 *   (hub pattern: expand { hash } against its own store before parsing)
 * - inputs.from must be document-internal (self-contained, spec §9)
 */
export function parseDocument(doc: unknown): ParsedDocument {
  const empty: Workspace = { root: '', config: { name: '', schema: 1 }, nodes: new Map(), parseIssues: [], texts: new Map() };
  const ctx: PlanCtx = { ws: empty };
  const root = plan(ctx, doc, '$');

  resolveMediaRefs(root);

  const nameIndex = new Map<string, Planned[]>();
  indexNames(root, nameIndex);
  resolveLabels(root, nameIndex, new Set());

  const docHashes = new Set<string>();
  collectHashes(root, docHashes);
  resolveFroms(root, docHashes, empty);

  const nodeHashes = new Map<string, PNode>();
  const collect = (p: Planned): void => {
    const { node, hash } = buildPlannedNode(p);
    nodeHashes.set(hash, node);
    for (const c of p.children) {
      if (c.kind === 'inline') collect(c.node);
    }
  };
  collect(root);
  const built = buildPlannedNode(root);
  return { root: built.node, rootHash: built.hash, nodeHashes };
}

export interface ParsedDocument {
  /** The built tree (defaults filled, from labels resolved to hashes) */
  root: PNode;
  /** Document identity = the root's Merkle hash over the whole subtree */
  rootHash: string;
  /** hash → node for every node of the document (roots and inline children) */
  nodeHashes: Map<string, PNode>;
}
