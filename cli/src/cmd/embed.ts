import fs from 'node:fs';
import { defaultDataDir } from '../state.js';
import { openWorkspace } from '../workspace.js';
import { nodeIndexFields } from '../retrieval.js';
import { notesByNode } from '../notes.js';
import {
  DEFAULT_MODEL,
  loadOnnxEmbedder,
  modelDir,
  modelFingerprint,
  modelStatus,
  pullModel,
  type ModelSpec,
} from '../embed/model.js';
import {
  buildVectorIndex,
  listVectorBuckets,
  pruneVectorBuckets,
  readVectorIndex,
} from '../embed/cache.js';

export interface EmbedOpts {
  dataDir?: string;
  positional: string[];
  json: boolean;
  /** build 时把本地笔记也嵌进去（与 search --notes 同一口径） */
  notes: boolean;
}

const USAGE = `usage: practi embed status|pull|build|prune [--json]
  practi embed status           model readiness and how many nodes the vector index covers
  practi embed pull             download the offline vector model into <data-dir>/models/
                                (~24MB, via the system proxy)
  practi embed build [--notes]  build / incrementally refresh the vector index (only nodes
                                not cached yet)
  practi embed prune            drop vector buckets left behind by an older model fingerprint

Semantic recall is an optional layer: without a model practi works as usual (lexical only),
and search --semantic says what is missing instead of quietly recalling less.`;

export async function runEmbed(opts: EmbedOpts): Promise<number> {
  const sub = opts.positional[0];
  const dataDir = opts.dataDir ?? defaultDataDir();
  switch (sub) {
    case 'status': return embedStatus(dataDir, opts);
    case 'pull': return await embedPull(dataDir, opts);
    case 'build': return await embedBuild(dataDir, opts);
    case 'prune': return embedPrune(dataDir, opts);
    default:
      console.error(USAGE);
      return 1;
  }
}

function embedStatus(dataDir: string, opts: EmbedOpts): number {
  const spec = DEFAULT_MODEL;
  const st = modelStatus(dataDir, spec);
  const fingerprint = modelFingerprint(spec);
  const index = readVectorIndex(dataDir, fingerprint);
  let nodes = 0;
  let covered = 0;
  try {
    const ws = openWorkspace(dataDir);
    nodes = ws.nodes.size;
    covered = index === null ? 0 : index.hashes.filter((h) => ws.nodes.has(h)).length;
  } catch {
    nodes = 0;
  }
  const buckets = listVectorBuckets(dataDir);
  if (opts.json) {
    console.log(JSON.stringify({
      model: { id: st.id, dir: st.dir, present: st.present, bytes: st.bytes, bad: st.bad },
      fingerprint,
      vectors: { nodes, covered, stale: index === null ? 0 : index.count - covered },
      buckets,
    }, null, 2));
    return 0;
  }
  console.log(`model:     ${st.id}  ${st.present ? 'ready' : 'NOT ready'}  (${(st.bytes / 1024 / 1024).toFixed(1)} MB in ${st.dir})`);
  if (!st.present) {
    for (const b of st.bad) console.log(`           ${b.file}: ${b.reason}`);
    console.log('           run `practi embed pull` to fetch it');
  }
  console.log(`fingerprint: ${fingerprint}`);
  console.log(`vectors:   ${covered}/${nodes} node(s) covered${index === null ? ' (no index yet — run `practi embed build`)' : ''}`);
  if (index !== null && index.count > covered) console.log(`           ${index.count - covered} stale entr(ies) — \`practi embed build\` refreshes`);
  if (buckets.length > 1) {
    console.log(`buckets:   ${buckets.length} (older model fingerprints kept; \`practi embed prune\` drops them)`);
    for (const b of buckets) console.log(`           ${b.fingerprint}  ${(b.bytes / 1024 / 1024).toFixed(1)} MB`);
  }
  return 0;
}

async function embedPull(dataDir: string, opts: EmbedOpts): Promise<number> {
  const spec = DEFAULT_MODEL;
  console.error(`pulling ${spec.id} (~${spec.files.reduce((s, f) => s + f.bytes, 0) / 1024 / 1024 | 0} MB) into ${modelDir(dataDir, spec)}`);
  const r = await pullModel(dataDir, {
    onProgress: (p) => console.error(`  ${p.file}: ${(p.done / 1024 / 1024).toFixed(1)} MB`),
  });
  if (opts.json) {
    console.log(JSON.stringify({ model: spec.id, dir: modelDir(dataDir, spec), ...r }, null, 2));
    return 0;
  }
  console.log(`pulled:  ${spec.id}`);
  if (r.downloaded.length > 0) console.log(`         downloaded ${r.downloaded.join(', ')}`);
  if (r.skipped.length > 0) console.log(`         already present ${r.skipped.join(', ')}`);
  console.log(`next:    practi embed build   (embeds every stored node once)`);
  return 0;
}

async function embedBuild(dataDir: string, opts: EmbedOpts): Promise<number> {
  const ws = openWorkspace(dataDir);
  const notes = opts.notes ? notesByNode(dataDir) : new Map<string, string>();
  const docs = [...ws.nodes.keys()].sort()
    .map((h) => ({ hash: h, text: indexText(h, ws.nodes.get(h)!, notes.get(h)) }));
  if (docs.length === 0) {
    console.log('no stored nodes to embed');
    return 0;
  }
  const embedder = await loadOnnxEmbedder(dataDir);
  const t0 = Date.now();
  const r = await buildVectorIndex({
    dataDir,
    embedder,
    docs,
    onProgress: (done, total) => process.stderr.write(`  embedding ${done}/${total}\r`),
  });
  await embedder.dispose();
  process.stderr.write('\n');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (opts.json) {
    console.log(JSON.stringify({
      model: embedder.id,
      fingerprint: r.index.fingerprint,
      nodes: r.index.count,
      embedded: r.embedded,
      reused: r.reused,
      dropped: r.dropped,
      seconds: Number(secs),
    }, null, 2));
    return 0;
  }
  console.log(`indexed: ${r.index.count} node(s) with ${embedder.id} in ${secs}s`);
  console.log(`         embedded ${r.embedded}, reused ${r.reused}${r.dropped > 0 ? `, dropped ${r.dropped} stale` : ''}`);
  console.log(`next:    practi search <query> --semantic`);
  return 0;
}

function indexText(hash: string, node: Parameters<typeof nodeIndexFields>[1], note?: string): string {
  const e = nodeIndexFields(hash, node, note);
  return Object.values(e.fields).filter((v): v is string => typeof v === 'string').join('\n');
}

function embedPrune(dataDir: string, opts: EmbedOpts): number {
  const keep = modelFingerprint(DEFAULT_MODEL);
  const before = listVectorBuckets(dataDir);
  const removed = pruneVectorBuckets(dataDir, keep);
  if (opts.json) {
    console.log(JSON.stringify({ kept: keep, removed, before }, null, 2));
    return 0;
  }
  if (removed.length === 0) console.log(`embed: nothing to prune (${before.length} bucket(s), all current)`);
  else console.log(`embed: removed ${removed.length} stale bucket(s) — ${removed.join(', ')}`);
  return 0;
}

