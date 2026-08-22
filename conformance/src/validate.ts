import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPS, extractMediaRefs } from './model.js';
import { readBlob, type Workspace } from './store.js';

export interface ValidationIssue {
  code: string;
  file: string;
  message: string;
  hint?: string;
  line?: number;
}

/** Find a top-level field (no indentation) in the full file text; 1-based line, never guessed */
function keyLine(text: string | undefined, field: string): number | undefined {
  if (text === undefined) return undefined;
  const idx = text.split('\n').findIndex(l => l.startsWith(`${field}:`));
  return idx === -1 ? undefined : idx + 1;
}

/** Find a children pin (- hash: sha256:…) in the full file text; 1-based line */
function childLine(text: string | undefined, childHash: string): number | undefined {
  if (text === undefined) return undefined;
  const idx = text.split('\n').findIndex(l => l.trim() === `- hash: ${childHash}`);
  return idx === -1 ? undefined : idx + 1;
}

/** Find an inline media reference ![…](name) in the full file text; 1-based line */
function mediaRefLine(text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
  const m = text.match(re);
  return m === null || m.index === undefined ? undefined : text.slice(0, m.index).split('\n').length;
}

function nodeFile(hash: string): string {
  return path.join('nodes', `${hash.slice('sha256:'.length)}.md`);
}

/**
 * Structural invariant checks (spec §6):
 * 1. attachments/inputs/outputs on actions only (hand-written on practices is rejected at parse time → parseIssues)
 * 2. references are hashes and must not dangle (a child pin or from names a node absent from the library)
 * 3. attachment blobs exist and their content matches the pointer hash (content-addressed reconciliation)
 * 4. stored node files hash to their own name (E_NODE_CORRUPT — reported by the store on load)
 *
 * Cycles and drift are structurally impossible: a child pin IS a content
 * hash, verified against the stored file at load; constructing a cycle would
 * require a SHA-256 fixed point, and a pin can never go stale because the
 * addressed content is immutable (§3.3).
 */
export function validateWorkspace(ws: Workspace): ValidationIssue[] {
  const issues: ValidationIssue[] = [...ws.parseIssues];

  for (const [hash, node] of ws.nodes) {
    const file = nodeFile(hash);
    const text = ws.texts.get(hash);
    if (node.type === 'action') {
      // Flow edges: from must point to an existing node (hash addressing; ordering/branch reachability not checked yet)
      node.inputs?.forEach((inp, i) => {
        if (inp.from !== undefined && !ws.nodes.has(inp.from)) {
          issues.push({
            code: 'E_FLOW_FROM',
            file,
            message: `inputs[${i}] ("${inp.name}") references a nonexistent node "${inp.from}" in from`,
            line: keyLine(text, 'inputs'),
          });
        }
      });
      // Inline media reference reconciliation (spec §5.1): ![caption](name) in
      // content must hit this node's attachment list. Names must be unique per
      // node (content resolves by name); practices carry no attachments, so not checked here.
      const attachmentNames = new Set((node.attachments ?? []).map(a => a.name));
      for (const ref of extractMediaRefs(node.content)) {
        // http(s) URL targets are valid external references (§5.1) — best-effort, not validated
        if (/^https?:\/\//i.test(ref)) continue;
        if (!attachmentNames.has(ref)) {
          issues.push({
            code: 'E_MEDIA_REF',
            file,
            message: `content references media "![](…)" named "${ref}", which is not in this node's attachments`,
            hint: 'inline references resolve by name against this node\'s attachments; http(s) URL targets are valid external references and are exempt',
            line: mediaRefLine(text, ref),
          });
        }
      }
      const seenNames = new Set<string>();
      node.attachments?.forEach((a, i) => {
        if (seenNames.has(a.name)) {
          issues.push({
            code: 'E_SCHEMA',
            file,
            message: `attachments[${i}] ("${a.name}") duplicates an earlier attachment name (content references attachments by name; names must be unique per node)`,
            line: keyLine(text, 'attachments'),
          });
        }
        seenNames.add(a.name);
      });
      // Blob reconciliation: blob exists + recomputed hash matches (the foundation of content addressing).
      // url-hosted attachments (§5) are external — bytes are not in the workspace, so they are exempt.
      node.attachments?.forEach((a, i) => {
        if (a.url !== undefined) return;
        const bytes = readBlob(ws.root, a.hash);
        if (bytes === null) {
          issues.push({
            code: 'E_BLOB_MISSING',
            file,
            message: `attachments[${i}] ("${a.name}"): blob missing (hash ${a.hash})`,
            hint: 'copy the blobs/ directory from the source workspace, or re-attach the file',
            line: keyLine(text, 'attachments'),
          });
          return;
        }
        const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (actual !== a.hash) {
          issues.push({
            code: 'E_BLOB_CORRUPT',
            file,
            message: `attachments[${i}] ("${a.name}"): blob content does not match the pointer hash (tampered or corrupted)`,
            hint: `actual content hash is ${actual}; re-fetch the attachment from its original source`,
            line: keyLine(text, 'attachments'),
          });
        } else if (a.size !== undefined && a.size !== bytes.length) {
          issues.push({
            code: 'E_BLOB_CORRUPT',
            file,
            message: `attachments[${i}] ("${a.name}"): declared size (${a.size}) does not match the blob's actual byte count (${bytes.length})`,
            line: keyLine(text, 'attachments'),
          });
        }
      });
      continue;
    }
    if (!(OPS as readonly string[]).includes(node.op)) {
      issues.push({ code: 'E_OP', file, message: `op "${node.op}" is not legal (expected ${OPS.join(' / ')})`, line: keyLine(text, 'op') });
    }
    if (node.loop !== undefined && node.op !== 'loop') {
      issues.push({ code: 'E_LOOP', file, message: 'loop config is only allowed on op=loop practices', line: keyLine(text, 'loop') });
    }
    node.children.forEach((ref, i) => {
      if (!ws.nodes.has(ref.hash)) {
        issues.push({
          code: 'E_DANGLING',
          file,
          message: `children[${i}] references "${ref.hash}", which is not stored in the workspace`,
          hint: 'dangling reference; the addressed content must exist under its own hash',
          line: childLine(text, ref.hash),
        });
      }
    });
  }

  return issues;
}

export interface UpgradeItem {
  parent: string;
  child: string;
  candidates: string[];
}

/** A from pin whose target has known refinements (§7 stale-pin annotation, local form — advisory, never an issue) */
export interface RefinableInput {
  node: string;
  input: string;
  from: string;
  candidates: string[];
}

/**
 * Upgrade report (reports, never mutates). With content addressing there is
 * no drift: a pin addresses immutable content and can never go stale (a
 * changed node is a new hash — old pins keep addressing the old content).
 * What remains is the refinement graph (§9.1): a practice whose refines points
 * at a hash is an improved version of it. Surfaces, both advisory:
 * - upgradeable: a parent's child pin whose target has refinements
 * - refinableInputs: a from pin whose target has refinements
 */
export function upgradeStatus(ws: Workspace): { upgradeable: UpgradeItem[]; refinableInputs: RefinableInput[] } {
  const refinements = new Map<string, string[]>();
  for (const [hash, node] of ws.nodes) {
    if (node.type !== 'practice' || node.refines === undefined) continue;
    const list = refinements.get(node.refines) ?? [];
    list.push(hash);
    refinements.set(node.refines, list);
  }
  const upgradeable: UpgradeItem[] = [];
  for (const [hash, node] of ws.nodes) {
    if (node.type !== 'practice') continue;
    for (const ref of node.children) {
      const child = ws.nodes.get(ref.hash);
      if (child?.type !== 'action') continue;
      const candidates = (refinements.get(ref.hash) ?? []).filter(h => h !== hash);
      if (candidates.length > 0) {
        upgradeable.push({ parent: hash, child: ref.hash, candidates });
      }
    }
  }
  const refinableInputs: RefinableInput[] = [];
  for (const [hash, node] of ws.nodes) {
    if (node.type !== 'action') continue;
    for (const inp of node.inputs ?? []) {
      if (inp.from === undefined) continue;
      const candidates = (refinements.get(inp.from) ?? []).filter(h => h !== hash);
      if (candidates.length > 0) {
        refinableInputs.push({ node: hash, input: inp.name, from: inp.from, candidates });
      }
    }
  }
  return { upgradeable, refinableInputs };
}
