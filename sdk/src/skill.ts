import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { stringify as stringifyYaml } from 'yaml';
import { PracticeError } from './errors.js';
import { createFromDoc } from './doc.js';
import { exportSubtree } from './export.js';
import { readBlob, resolveNodeRef, storeBlob, type Workspace } from './store.js';
import type { Attachment } from './model.js';

/**
 * Skill ⇄ POP conversion (spec §1/§8).
 *
 * The POP is the parent artifact; a skill directory is one of its projections.
 * `exportSkill` writes a readable SKILL.md plus attachment files and, next to
 * them, the canonical document JSON as a sidecar (`pop.doc.json`).
 * `importSkill` is the inverse of export — nothing more:
 *
 * - Sidecar present & in sync → exact replay: the same document, byte-identical
 *   hash, on any machine. Attachment files ride along in the directory and are
 *   re-staged into the local blob store, each verified against its pointer.
 * - Sidecar present but SKILL.md was hand-edited (drift) → "the body wins":
 *   a warning fires and the edited body is converted fresh (a new hash — fork
 *   semantics). This is the one legitimate mechanical conversion, because at
 *   that moment the document's truth genuinely is the body.
 * - No sidecar → rejected (`E_NO_SIDECAR`). A foreign skill enters POP by
 *   (re)authoring: an agent reads it and composes a structured tree of
 *   practices and actions. Mechanical flattening — one action, whole body in
 *   `content` — would discard exactly the structure POP exists for.
 */

export const SKILL_FILE = 'SKILL.md';
export const SIDECAR_FILE = 'pop.doc.json';

/** Minimal structural view of an exported document (exportSubtree output) */
interface DocNode {
  type: string;
  name: string;
  content: string;
  description?: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
  children?: DocNode[];
}

export interface ImportSkillResult {
  root: string;
  created: string[];
  count: number;
  /** true = replayed from the sidecar (byte-identical hash); false = converted from the SKILL.md body */
  sidecarUsed: boolean;
  /** true = a sidecar existed but SKILL.md had been edited after export (drift) */
  drift: boolean;
}

export interface ExportSkillResult {
  rootHash: string;
  name: string;
  /** attachment files written next to SKILL.md (POSIX-relative names) */
  files: string[];
}

function listFiles(dir: string, base: string = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** YAML → JSON coercion: gray-matter parses dates into Date objects; metadata participates in the hash as JSON */
function toJsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toJsonValue(val);
  return out;
}

/**
 * Deterministic SKILL.md rendering (frontmatter + projected body). The same
 * function serves export and the import-side drift check, so an untouched
 * export always compares equal.
 */
export function renderSkillMarkdown(doc: Record<string, unknown>): string {
  const d = doc as unknown as DocNode;
  const fm: Record<string, unknown> = { name: d.name };
  if (typeof d.description === 'string' && d.description.trim() !== '') fm.description = d.description;
  if (d.metadata !== undefined && Object.keys(d.metadata).length > 0) {
    for (const k of Object.keys(d.metadata).sort()) fm[k] = d.metadata[k];
  }
  const body = renderBody(d, 0);
  return `---\n${stringifyYaml(fm)}---\n${body ? `\n${body}\n` : '\n'}`;
}

function renderBody(d: DocNode, depth: number): string {
  const parts: string[] = [];
  const content = typeof d.content === 'string' ? d.content.trim() : '';
  if (content) parts.push(content);
  if (d.children !== undefined) {
    for (const child of d.children) {
      const inner = renderBody(child, depth + 1);
      const level = depth + 2;
      const heading = level <= 6 ? `${'#'.repeat(level)} ${child.name}` : `**${child.name}**`;
      parts.push(inner ? `${heading}\n\n${inner}` : heading);
    }
  }
  return parts.join('\n\n');
}

/** Drift-path conversion (hand-edited body): SKILL.md + directory files → root action document */
function freshDocFromSkill(ws: Workspace, skillDir: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf8');
  const { data, content } = matter(raw);
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    throw new PracticeError('E_SCHEMA', 'SKILL.md frontmatter must carry `name`', {
      hint: 'add a `name:` field to the frontmatter block',
    });
  }
  const doc: Record<string, unknown> = { type: 'action', name: data.name, content };
  if (typeof data.description === 'string' && data.description.trim() !== '') doc.description = data.description;

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'name' || k === 'description' || v === undefined) continue;
    metadata[k] = toJsonValue(v);
  }
  if (Object.keys(metadata).length > 0) doc.metadata = metadata;

  const attachments: Attachment[] = [];
  for (const rel of listFiles(skillDir)) {
    if (rel === SKILL_FILE || rel === SIDECAR_FILE) continue;
    const bytes = fs.readFileSync(path.join(skillDir, rel));
    attachments.push({ name: rel, hash: storeBlob(ws.root, bytes), size: bytes.length });
  }
  if (attachments.length > 0) doc.attachments = attachments;
  return doc;
}

/**
 * Sidecar replay: re-stage the directory's attachment files into the local blob
 * store, verifying each against its pointer — a faithful export carries bytes
 * that agree with the hashes it declares.
 */
function stageSidecarAttachments(ws: Workspace, skillDir: string, doc: Record<string, unknown>): void {
  const attachments: Attachment[] = [];
  collectAttachments(doc as unknown as DocNode, attachments, new Set());
  for (const att of attachments) {
    const file = path.join(skillDir, ...att.name.split('/'));
    if (!fs.existsSync(file)) {
      throw new PracticeError('E_BLOB_MISSING', `sidecar declares attachment "${att.name}" (${att.hash}) but the directory has no such file`, {
        hint: 'an export writes it next to SKILL.md — restore the file, or fix the document',
      });
    }
    const stored = storeBlob(ws.root, fs.readFileSync(file));
    if (stored !== att.hash) {
      throw new PracticeError('E_BLOB_CORRUPT', `attachment "${att.name}" disagrees with its pointer: file hashes to ${stored}, document declares ${att.hash}`, {
        hint: 'restore the original file, or fix the document',
      });
    }
  }
}

/** Import a skill directory into the workspace. Sidecar present & in sync → exact replay; drifted → warn + body wins; no sidecar → rejected. */
export function importSkill(
  ws: Workspace,
  skillDir: string,
  opts?: { warn?: (message: string) => void },
): ImportSkillResult {
  if (!fs.existsSync(path.join(skillDir, SKILL_FILE))) {
    throw new PracticeError('E_NOT_FOUND', `no SKILL.md at ${skillDir}`, {
      hint: 'pass the skill directory (the one containing SKILL.md)',
    });
  }

  const sidecarPath = path.join(skillDir, SIDECAR_FILE);
  const hasSidecar = fs.existsSync(sidecarPath);
  let doc: Record<string, unknown> | undefined;
  let sidecarUsed = false;
  let drift = false;
  if (hasSidecar) {
    const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf8');
    let sidecarDoc: unknown;
    try {
      sidecarDoc = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch {
      throw new PracticeError('E_SCHEMA', `${SIDECAR_FILE} is not valid JSON`, {
        hint: `re-export the POP, or delete the sidecar and author a document from the body`,
      });
    }
    const expected = renderSkillMarkdown(sidecarDoc as Record<string, unknown>);
    if (raw.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')) {
      stageSidecarAttachments(ws, skillDir, sidecarDoc as Record<string, unknown>);
      doc = sidecarDoc as unknown as Record<string, unknown>;
      sidecarUsed = true;
    } else {
      drift = true;
      opts?.warn?.(
        'SKILL.md was edited after export (pop.doc.json is out of sync) — importing the edited body as truth; a new hash will be produced',
      );
    }
  }
  if (doc === undefined) {
    if (!hasSidecar) {
      throw new PracticeError('E_NO_SIDECAR', `${skillDir} carries no ${SIDECAR_FILE} — not a \`pop skill export\` output`, {
        hint: 'import is the inverse of export (sidecar replay). A foreign skill enters POP by authoring: read it and write a structured practice/action tree (see the use-pop skill) — flattening its text into one node discards the structure POP exists for',
      });
    }
    doc = freshDocFromSkill(ws, skillDir);
  }

  const { root, created, count } = createFromDoc(ws, doc);
  return { root, created, count, sidecarUsed, drift };
}

/** Flat-name guard: attachment names become filesystem paths under outDir */
function assertSafeAttachmentName(name: string): void {
  if (
    name === '' ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.split('/').includes('..')
  ) {
    throw new PracticeError('E_SCHEMA', `unsafe attachment name "${name}"`, {
      hint: 'attachment names must be relative POSIX paths without `..` segments',
    });
  }
}

function collectAttachments(d: DocNode, out: Attachment[], seen: Set<string>): void {
  if (d.attachments !== undefined) {
    for (const att of d.attachments) {
      assertSafeAttachmentName(att.name);
      if (seen.has(att.name)) {
        throw new PracticeError('E_SCHEMA', `duplicate attachment name "${att.name}" across nodes`, {
          hint: 'flat skill directories cannot carry the same attachment name twice',
        });
      }
      seen.add(att.name);
      out.push(att);
    }
  }
  for (const child of d.children ?? []) collectAttachments(child, out, seen);
}

/** Export a workspace subtree as a skill directory: SKILL.md (projection) + attachment files + pop.doc.json sidecar. */
export function exportSkill(ws: Workspace, ref: string, outDir: string): ExportSkillResult {
  const hash = resolveNodeRef(ws, ref);
  const node = ws.nodes.get(hash);
  if (node === undefined) throw new PracticeError('E_NOT_FOUND', `node "${ref}" does not exist`);
  const doc = exportSubtree(node, ws.nodes);

  if (fs.existsSync(path.join(outDir, SKILL_FILE))) {
    throw new PracticeError('E_EXISTS', `${outDir} already contains a SKILL.md`, {
      hint: 'choose an empty/new --dir',
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, SKILL_FILE), renderSkillMarkdown(doc), 'utf8');

  const attachments: Attachment[] = [];
  collectAttachments(doc as unknown as DocNode, attachments, new Set());
  for (const att of attachments) {
    const bytes = readBlob(ws.root, att.hash);
    if (bytes === null) {
      throw new PracticeError('E_BLOB_MISSING', `attachment "${att.name}" (${att.hash}) has no blob in this workspace`);
    }
    const target = path.join(outDir, ...att.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  fs.writeFileSync(path.join(outDir, SIDECAR_FILE), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { rootHash: hash, name: (doc as unknown as DocNode).name, files: attachments.map((a) => a.name) };
}
