import {
  PracticeError,
  aggregateView,
  exportSubtree,
  parseDocument,
  resolveNodeRef,
  type PNode,
} from '@arshdelight/pop-sdk';
import { openPool, resolveRepo } from '../practice.js';
import { renderSteps, viewHeader, shortHash } from '../render.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { fetchDirectInstance, fetchDirectRevision, normalizeHashRef } from '../client.js';
import { parseCloneRef } from './clone.js';

export interface ShowOpts {
  dir?: string;
  hash: string;
  json: boolean;
  doc: boolean;
  /** --rev <hash|vN>：只对 hub 地址有意义（本地哈希前缀解析走 resolveNodeRef） */
  rev?: string;
  /** 配置家（远程模式读凭据与 remote）；本地模式不用 */
  dataDir?: string;
}

/** Inspect one node: aggregate view (default), --json for the StandardView, --doc for the document form.
 *
 * 地址带 `<owner>/<name>`（含 `@branch`）= 直接读 hub，不经过本地文件夹；不带 `/`
 * = 本地哈希（前缀 OK），写法与行为不变。
 *
 * 哈希纪律：本地索引本身即验证（loadWorkspace 重算每个节点，名实不符的 E_NODE_CORRUPT
 * 不进索引）——show 在「没找到」时先翻损坏记录，把「找到但哈希不正确」和「从未存在」
 * 分开说话。远程同纪律：hub 回来的文档先 parseDocument 验根，名实不符拒绝渲染。 */
export async function runShow(opts: ShowOpts): Promise<number> {
  if (opts.hash.includes('/')) return showRemote(opts);
  const repo = resolveRepo({ dir: opts.dir, verb: 'show' });
  if (repo === null) return 1;
  const ws = openPool(repo);
  let hash: string;
  try {
    hash = resolveNodeRef(ws, opts.hash);
  } catch (e) {
    if (!(e instanceof PracticeError) || e.code !== 'E_NOT_FOUND') throw e;
    const hex = opts.hash.replace(/^sha256:/i, '').toLowerCase();
    const corrupt = ws.parseIssues.find(
      (i) => i.code === 'E_NODE_CORRUPT' && i.file.endsWith(`${hex}.md`)
    );
    if (corrupt) {
      console.error(`error [E_NODE_CORRUPT]: the node file exists locally, but ${corrupt.message}`);
      if (corrupt.hint) console.error(`  hint: ${corrupt.hint}`);
      return 1;
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      console.error(`error [E_NOT_FOUND]: node "${opts.hash}" is not in the local workspace (prefixes resolve only locally)`);
      return 1;
    }
    console.error(`error [E_NOT_FOUND]: node "${opts.hash}" is not in the local workspace`);
    return 1;
  }
  return renderNode(hash, ws.nodes, opts);
}

/** practi show <owner>/<name>[@branch] [--rev <hash|vN>] [--doc] [--json]：直读 hub。
 *  取实例视图定位支头（或 --rev 指定的版本），再取 …/revisions/{hash}；文档先验根
 *  （parseDocument 的根必须等于请求的哈希）才渲染——渲染走纯函数，不落 workspace。 */
async function showRemote(opts: ShowOpts): Promise<number> {
  const usage =
    'usage: practi show <owner>/<name>[@branch] [--rev <hash|vN>] [--json] [--doc]   |   practi show <hash>   (local)';
  const parsed = parseCloneRef(opts.hash);
  if (!parsed || parsed.owner === undefined) {
    console.error('error: a hub practice needs its owner — `practi show <owner>/<name>[@branch]` (a bare name is ambiguous with a local hash)');
    console.error(usage);
    return 1;
  }
  const dataDir = opts.dataDir ?? defaultDataDir();
  const remote = remoteUrl(dataDir);
  const view = await fetchDirectInstance(dataDir, remote, parsed.owner, parsed.name, parsed.branch);

  // 定位要显示的修订：--rev（vN / 完整哈希 / 前缀）或支头
  let hash: string | null = null;
  let rev: { seq: number; root_hash: string; parent_hash: string | null; message: string; created_at: string; status: string } | null = null;
  if (opts.rev !== undefined) {
    const vm = /^v(\d+)$/i.exec(opts.rev.trim());
    if (vm) {
      const seq = Number(vm[1]);
      rev = view.revisions.find((r) => r.seq === seq) ?? null;
      if (rev === null) {
        console.error(`error: no revision v${seq} on ${parsed.owner}/${parsed.name}@${view.branch} (this branch has ${view.revisions.length})`);
        return 1;
      }
      hash = rev.root_hash;
    } else {
      const full = normalizeHashRef(opts.rev);
      if (full !== null) {
        // 完整哈希直接取：在不在支的可见列表里由 hub 说了算（非 owner 的列表只有已公开版本）
        hash = full;
        rev = view.revisions.find((r) => r.root_hash === full) ?? null;
      } else {
        const hex = opts.rev.replace(/^sha256:/i, '').toLowerCase();
        const hits = view.revisions.filter((r) => r.root_hash.startsWith(`sha256:${hex}`));
        if (hits.length > 1) {
          console.error(`error: --rev ${opts.rev} is ambiguous — ${hits.length} revisions share this prefix (give more characters)`);
          return 1;
        }
        rev = hits[0] ?? null;
        if (rev === null) {
          console.error(`error: no revision matching "${opts.rev}" on ${parsed.owner}/${parsed.name}@${view.branch}`);
          return 1;
        }
        hash = rev.root_hash;
      }
    }
  } else {
    hash = view.branch_head_hash;
    if (hash === null) {
      console.error(`error: ${parsed.owner}/${parsed.name}@${view.branch} has no revisions yet`);
      return 1;
    }
    rev = view.revisions.find((r) => r.root_hash === hash) ?? null;
  }

  const fetched = await fetchDirectRevision(dataDir, remote, parsed.owner, parsed.name, hash);
  const doc = parseDocument(fetched.document);
  if (doc.rootHash !== hash) {
    console.error(`error: ${hash} — hash mismatch: the document the hub returned hashes to ${doc.rootHash} (refusing to render)`);
    return 1;
  }

  if (opts.doc) {
    // 支头给提交基准（写入门的 --base vN），旧版说明它不是头；不在可见列表里的版本
    // 不知道是不是头，不打提示——stdout 保持纯 JSON
    if (rev !== null) {
      if (hash === view.branch_head_hash) {
        console.error(`note: this is v${rev.seq}, the branch head (${shortHash(hash)}) — when committing on top of it, pass --base v${rev.seq}`);
      } else {
        console.error(`note: this is v${rev.seq}, not the branch head (head: v${view.revisions[0]?.seq})`);
      }
    }
    console.log(JSON.stringify(exportSubtree(doc.root, doc.nodeHashes), null, 2));
    return 0;
  }
  return renderNode(hash, doc.nodeHashes, opts);
}

/** 本地与远程共用的渲染出口：聚合视图（默认）、--json 机器视图、--doc 文档形态。
 *  nodes 是纯数据（本地=池索引，远程=parseDocument 的 nodeHashes），渲染不落盘。 */
function renderNode(hash: string, nodes: Map<string, PNode>, opts: ShowOpts): number {
  const node = nodes.get(hash)!;

  if (opts.doc) {
    console.log(JSON.stringify(exportSubtree(node, nodes), null, 2));
    return 0;
  }

  // --json 传 full：机器视图带每步正文，AI 一次读全免逐哈希往返；人类文本仍走紧凑骨架
  const view = aggregateView(hash, nodes, opts.json ? { full: true } : undefined);
  // 读取宽容、出口报错：视图照常产出（丢的子树有占位条目），但缺失必须被看见——
  // 人类文本在尾部追加 E_MISSING 块，退出码 1；--json 由消费方读 view.missing 自行处置
  const code = view.missing !== undefined ? 1 : 0;
  if (opts.json) {
    console.log(JSON.stringify(view, null, 2));
    return code;
  }

  console.log(viewHeader(view));
  if (view.description !== undefined) console.log(`\ndescription: ${view.description}`);
  if (view.content !== undefined && view.content.trim() !== '') console.log(`\n${view.content}`);

  if (view.steps.length > 0) {
    console.log('\nsteps:');
    for (const line of renderSteps(view.steps, nodes)) console.log(`  ${line}`);
  }
  if (view.flow.length > 0) {
    console.log('\nflow:');
    for (const e of view.flow) {
      console.log(`  ${e.name}  ${short(e.fromHash)} (${e.fromName}) → ${short(e.toHash)} (${e.toName})`);
    }
  }
  // 对外清单（spec §7，2.2.0）：实践之外要备好的 / 实践最终交出的。动作视图下它与下面的
  // declared 两表重复（叶子内看不见消费者），只对 practice 打印
  if (view.type === 'practice' && view.externalInputs.length > 0) {
    console.log('\nexternal inputs (prepare these outside the practice):');
    for (const d of mergedBySpec(view.externalInputs)) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.type === 'practice' && view.finalOutputs.length > 0) {
    console.log('\nfinal outputs (what this practice yields):');
    for (const d of mergedBySpec(view.finalOutputs)) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.inputs.length > 0) {
    console.log('\ndeclared inputs (needs):');
    for (const d of view.inputs) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.outputs.length > 0) {
    console.log('\ndeclared outputs (produces):');
    for (const d of view.outputs) console.log(`  ${d.name}${d.spec ? ` — ${d.spec}` : ''}  [${short(d.refHash)}]`);
  }
  if (view.attachments.length > 0) {
    console.log('\nattachments:');
    for (const a of view.attachments) console.log(`  ${a.name}  ${a.mime ?? ''}  ${a.size ?? ''}b  ${short(a.hash)}`);
  }
  // notice 垫底：节点的各节都打完才轮到提醒（与 practi web 的阅读器同序，用户 2026-11-24 定）
  if (view.notice !== undefined) console.log(`\nnotice: ${view.notice}`);
  if (view.missing !== undefined && view.missing.length > 0) {
    console.error(`\nerror [E_MISSING]: ${view.missing.length} referenced node(s) absent from this workspace:`);
    for (const m of view.missing) {
      console.error(`  ${m.hash}  (referenced by "${m.parentName}" ${short(m.parentHash)})`);
    }
    console.error('  the view above shows placeholders where they belong — the node files are gone (or never synced here)');
  }
  return code;
}

/** 派生清单按「名 + 规格」合并：同一样东西被多个步骤声明时只列一次（视图里逐条留着来源步骤，
 *  给需要来源的渲染方；人读的清单不该出现三行「跑鞋」） */
function mergedBySpec<T extends { name: string; spec?: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.name}\u0000${d.spec ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function short(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 12);
}
