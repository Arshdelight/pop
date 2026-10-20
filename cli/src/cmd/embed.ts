import fs from 'node:fs';
import { openPool, resolveRepo, type Repo } from '../practice.js';
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
  dir?: string;
  positional: string[];
  json: boolean;
  /** build 时把本地笔记也嵌进去（与 search --notes 同一口径） */
  notes: boolean;
}

const USAGE = `usage: practi embed status|pull|build|prune [--json]
  practi embed status           model readiness and how many nodes the vector index covers
  practi embed pull             download the offline vector model into .practi/models/
                                (~24MB, via the system proxy)
  practi embed build [--notes]  build / incrementally refresh the vector index (only nodes
                                not cached yet)
  practi embed prune            drop vector buckets left behind by an older model fingerprint

Semantic recall is an optional layer: without a model practi works as usual (lexical only),
and search --semantic says what is missing instead of quietly recalling less.`;

export async function runEmbed(opts: EmbedOpts): Promise<number> {
  const sub = opts.positional[0];
  const repo = resolveRepo({ dir: opts.dir, verb: 'embed' });
  if (repo === null) return 1;
  switch (sub) {
    case 'status': return embedStatus(repo, opts);
    case 'pull': return await embedPull(repo, opts);
    case 'build': return await embedBuild(repo, opts);
    case 'prune': return embedPrune(repo, opts);
    default:
      console.error(USAGE);
      return 1;
  }
}

function embedStatus(repo: Repo, opts: EmbedOpts): number {
  const base = repo.poolDir;
  const spec = DEFAULT_MODEL;
  const st = modelStatus(base, spec);
  const fingerprint = modelFingerprint(spec);
  const index = readVectorIndex(base, fingerprint);
  let nodes = 0;
  let covered = 0;
  try {
    const ws = openPool(repo);
    nodes = ws.nodes.size;
    covered = index === null ? 0 : index.hashes.filter((h) => ws.nodes.has(h)).length;
  } catch {
    nodes = 0;
  }
  const buckets = listVectorBuckets(base);
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

async function embedPull(repo: Repo, opts: EmbedOpts): Promise<number> {
  const base = repo.poolDir;
  const spec = DEFAULT_MODEL;
  console.error(`pulling ${spec.id} (~${spec.files.reduce((s, f) => s + f.bytes, 0) / 1024 / 1024 | 0} MB) into ${modelDir(base, spec)}`);
  const r = await pullModel(base, {
    onProgress: (p) => console.error(`  ${p.file}: ${(p.done / 1024 / 1024).toFixed(1)} MB`),
  });
  if (opts.json) {
    console.log(JSON.stringify({ model: spec.id, dir: modelDir(base, spec), ...r }, null, 2));
    return 0;
  }
  console.log(`pulled:  ${spec.id}`);
  if (r.downloaded.length > 0) console.log(`         downloaded ${r.downloaded.join(', ')}`);
  if (r.skipped.length > 0) console.log(`         already present ${r.skipped.join(', ')}`);
  console.log(`next:    practi embed build   (embeds every stored node once)`);
  return 0;
}

async function embedBuild(repo: Repo, opts: EmbedOpts): Promise<number> {
  const base = repo.poolDir;
  const ws = openPool(repo);
  const notes = opts.notes ? notesByNode(base) : new Map<string, string>();
  const docs = [...ws.nodes.keys()].sort()
    .map((h) => ({ hash: h, text: indexText(h, ws.nodes.get(h)!, notes.get(h)) }));
  if (docs.length === 0) {
    console.log('no stored nodes to embed');
    return 0;
  }
  const embedder = await loadOnnxEmbedder(base);
  const t0 = Date.now();
  const r = await buildVectorIndex({
    dataDir: base,
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

function embedPrune(repo: Repo, opts: EmbedOpts): number {
  const base = repo.poolDir;
  const keep = modelFingerprint(DEFAULT_MODEL);
  const before = listVectorBuckets(base);
  const removed = pruneVectorBuckets(base, keep);
  if (opts.json) {
    console.log(JSON.stringify({ kept: keep, removed, before }, null, 2));
    return 0;
  }
  if (removed.length === 0) console.log(`embed: nothing to prune (${before.length} bucket(s), all current)`);
  else console.log(`embed: removed ${removed.length} stale bucket(s) — ${removed.join(', ')}`);
  return 0;
}

