import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateView, type StandardView } from '../src/aggregate.js';
import { createFromDoc } from '../src/doc.js';
import { initWorkspace, loadWorkspace, resolveNodeRef } from '../src/store.js';
import { upgradeStatus, validateWorkspace } from '../src/validate.js';

/**
 * Test helpers: thin wrappers over the protocol functions; file I/O lives at this layer.
 */

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'practice-test-'));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Opts = Record<string, any>;

export async function runInit(dir: string, _opts: Opts = {}) {
  return initWorkspace(dir);
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(dir, file), 'utf8'));
}

export async function runCreate(dir: string, opts: Opts) {
  return createFromDoc(loadWorkspace(dir), readJson(dir, opts.file));
}

export async function runShow(dir: string, opts: Opts): Promise<StandardView> {
  const ws = loadWorkspace(dir);
  return aggregateView(resolveNodeRef(ws, opts.hash), ws.nodes, { full: opts.full === true });
}

export async function runValidate(dir: string, _opts: Opts = {}) {
  const ws = loadWorkspace(dir);
  const issues = validateWorkspace(ws);
  return { ok: issues.length === 0, nodeCount: ws.nodes.size, issues };
}

export async function runStatus(dir: string, _opts: Opts = {}) {
  return upgradeStatus(loadWorkspace(dir));
}

/** Quick node creation (single-node shortcut over the spec §1 document form): input accepts name@from(hash), output accepts name=spec or JSON */
function parseOptItem(s: string): Record<string, unknown> {
  if (s.startsWith('{')) return JSON.parse(s);
  const eq = s.indexOf('=');
  return eq === -1 ? { name: s } : { name: s.slice(0, eq), spec: s.slice(eq + 1) };
}

function parseFlowOpt(s: string): Record<string, unknown> {
  if (s.startsWith('{')) return JSON.parse(s);
  const at = s.indexOf('@');
  return at === -1 ? { name: s } : { name: s.slice(0, at), from: s.slice(at + 1) };
}

export async function runAddAction(dir: string, opts: Opts) {
  const doc: Record<string, unknown> = { name: opts.name, content: opts.content ?? '' };
  if (opts.input !== undefined) doc.inputs = opts.input.map(parseFlowOpt);
  if (opts.output !== undefined) doc.outputs = opts.output.map(parseOptItem);
  return createFromDoc(loadWorkspace(dir), doc);
}

export async function runAddPractice(dir: string, opts: Opts) {
  const children: unknown[] = opts.children;
  if (!Array.isArray(children) || children.length === 0) {
    const err = new Error('children is required') as Error & { code: string };
    err.code = 'E_CHILD_MISSING';
    throw err;
  }
  const doc: Record<string, unknown> = {
    name: opts.name,
    op: opts.op,
    children,
  };
  if (opts.count !== undefined) doc.loop = { mode: 'count', count: opts.count };
  return createFromDoc(loadWorkspace(dir), doc);
}
