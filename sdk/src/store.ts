import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { PracticeError } from './errors.js';
import { computeNodeHash } from './hash.js';
import { parseNodeFromMatter, type PNode } from './model.js';

export const CONFIG_FILE = 'practice.yaml';
export const NODES_DIR = 'nodes';
export const BLOBS_DIR = 'blobs';
export interface ParseIssue {
  code: string;
  file: string;
  message: string;
  hint?: string;
  line?: number;
}

export interface Workspace {
  root: string;
  config: { name: string; schema: number };
  /** Keyed by content hash — the only address a node has (§3) */
  nodes: Map<string, PNode>;
  parseIssues: ParseIssue[];
  /** hash → full raw file text, for validate to locate error lines */
  texts: Map<string, string>;
}

/** Explicit workspace initialization (writes practice.yaml + nodes/). Reports E_EXISTS if already initialized. */
export function initWorkspace(root: string): { root: string; name: string; schema: number } {
  if (fs.existsSync(path.join(root, CONFIG_FILE))) {
    throw new PracticeError('E_EXISTS', `${root} is already a practice workspace`, {
      hint: 'delete practice.yaml to re-initialize',
    });
  }
  fs.mkdirSync(path.join(root, NODES_DIR), { recursive: true });
  const name = path.basename(root);
  fs.writeFileSync(path.join(root, CONFIG_FILE), `name: ${name}\nschema: 1\n`, 'utf8');
  return { root, name, schema: 1 };
}

/**
 * Node addressing: a full content hash (sha256: prefix optional) or a unique
 * prefix of it (≥4 hex digits, global identity). Ambiguous prefixes raise
 * E_AMBIGUOUS listing the candidates. There are no local names — the hash is
 * the only address (§3).
 */
export function resolveNodeRef(ws: Workspace, ref: string): string {
  const hex = ref.replace(/^sha256:/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) {
    const full = `sha256:${hex}`;
    if (ws.nodes.has(full)) return full;
  } else if (/^[0-9a-f]{4,63}$/.test(hex)) {
    const hits = [...ws.nodes.keys()].filter(h => h.slice('sha256:'.length).startsWith(hex));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new PracticeError('E_AMBIGUOUS', `hash prefix "${ref}" matches ${hits.length} nodes`, {
        hint: `lengthen the prefix: ${hits.slice(0, 5).join(', ')}`,
      });
    }
  }
  throw new PracticeError('E_NOT_FOUND', `node "${ref}" does not exist`);
}

/**
 * Files are the whole truth: rebuild the index on every scan of nodes/.
 * A node file's NAME is its content hash; load recomputes and reconciles —
 * a mismatch (hand-edited file) is E_NODE_CORRUPT and the node is not indexed.
 * Content addressing makes stale pins
 * impossible, and tampering is caught here. A single unparseable file does
 * not abort the load; it is recorded in parseIssues for validate to report.
 */
export function loadWorkspace(root: string): Workspace {
  let config: { name: string; schema: number } = { name: path.basename(root), schema: 1 };
  const configPath = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> | null;
      config = {
        name: typeof parsed?.name === 'string' && parsed.name ? parsed.name : config.name,
        schema: typeof parsed?.schema === 'number' ? parsed.schema : 1,
      };
    } catch {
      // Fall back to defaults on a broken config; do not abort
    }
  }

  const nodes = new Map<string, PNode>();
  const parseIssues: ParseIssue[] = [];
  const texts = new Map<string, string>();
  const nodesDir = path.join(root, NODES_DIR);
  if (fs.existsSync(nodesDir)) {
    for (const file of fs.readdirSync(nodesDir).filter(f => f.endsWith('.md')).sort()) {
      const rel = path.join(NODES_DIR, file);
      const fileHash = path.basename(file, '.md');
      if (!/^[0-9a-f]{64}$/.test(fileHash)) {
        parseIssues.push({ code: 'E_PARSE', file: rel, message: `node file name must be a 64-hex content hash, got "${fileHash}"` });
        continue;
      }
      try {
        const raw = fs.readFileSync(path.join(nodesDir, file), 'utf8');
        const { data, content, matter: fmText } = matter(raw);
        const node = parseNodeFromMatter(
          data as Record<string, unknown>,
          content.replace(/^\n/, '').replace(/\s+$/, ''),
          typeof fmText === 'string' ? fmText.replace(/^\n/, '') : undefined,
        );
        const actual = computeNodeHash(node);
        if (actual !== `sha256:${fileHash}`) {
          parseIssues.push({
            code: 'E_NODE_CORRUPT',
            file: rel,
            message: `node content hashes to ${actual}, but the file is named sha256:${fileHash}`,
            hint: 'a stored node is immutable — editing it changes its identity; save the edited node under its new hash instead (references to the old hash keep addressing the old content)',
          });
          continue;
        }
        nodes.set(actual, node);
        texts.set(actual, raw);
      } catch (err) {
        if (err instanceof PracticeError) {
          parseIssues.push({ code: err.code, file: rel, message: err.message, hint: err.hint, ...(err.line !== undefined ? { line: err.line } : {}) });
        } else {
          parseIssues.push({ code: 'E_PARSE', file: rel, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  return { root, config, nodes, parseIssues, texts };
}

export function nodeToMarkdown(node: PNode): string {
  const fm: Record<string, unknown> = { type: node.type, name: node.name };
  if (node.description !== undefined) fm.description = node.description;
  if (node.license !== undefined) fm.license = node.license;
  if (node.metadata !== undefined && Object.keys(node.metadata).length > 0) fm.metadata = node.metadata;
  if (node.revisions !== undefined && node.revisions.length > 0) fm.revisions = node.revisions;
  if (node.type === 'action') {
    if (node.attachments !== undefined && node.attachments.length > 0) fm.attachments = node.attachments;
    if (node.inputs !== undefined) fm.inputs = node.inputs;
    if (node.outputs !== undefined) fm.outputs = node.outputs;
  } else {
    fm.op = node.op;
    fm.children = node.children;
    if (node.loop !== undefined) fm.loop = node.loop;
    if (node.refines !== undefined) fm.refines = node.refines;
  }
  return matter.stringify(`\n${node.content}`, fm);
}

/** A node file is named by its content hash (the sha256: prefix never enters the path) */
export function nodeFilePath(root: string, hash: string): string {
  return path.join(root, NODES_DIR, `${hash.slice('sha256:'.length)}.md`);
}

/** Persist a node under its content hash; returns the hash. Saving the same node again is idempotent. */
export function saveNode(root: string, node: PNode): string {
  const hash = computeNodeHash(node);
  fs.mkdirSync(path.join(root, NODES_DIR), { recursive: true });
  fs.writeFileSync(nodeFilePath(root, hash), nodeToMarkdown(node), 'utf8');
  return hash;
}

/** Content-addressed blob path: blobs/<first 2 hex>/<64 hex> (the sha256: prefix never enters the path) */
export function blobPath(root: string, hash: string): string {
  const hex = hash.slice('sha256:'.length);
  return path.join(root, BLOBS_DIR, hex.slice(0, 2), hex);
}

/** Store attachment bytes (sha256 content-addressed, idempotent for identical content); returns the hash */
export function storeBlob(root: string, bytes: Buffer): string {
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const p = blobPath(root, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  }
  return hash;
}

/** Read a blob; null when absent (existence/integrity checks belong to validate) */
export function readBlob(root: string, hash: string): Buffer | null {
  const p = blobPath(root, hash);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
