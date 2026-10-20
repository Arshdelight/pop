import fs from 'node:fs';
import { loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { createRepo, saveChain } from '../practice.js';
import { printQualityHints } from '../quality.js';
import { shortHash } from '../render.js';
import { subtreeFiles } from '../workspace.js';
import { describeRefresh, refreshVectors } from '../embed/optional.js';
import { nodeIndexFields } from '../retrieval.js';

export interface NewOpts {
  positional: string[];
  /** --base <file.json>：用一篇现成的 pop 文档诞生第一版（缺省=空仓库） */
  base?: string;
  message?: string;
}

/**
 * practi new <name> [--base <file.json>] [-m <msg>]：
 * 在 cwd 诞生实例文件夹 <name>/——工作文件 <name>.json（pop 本体，任何编辑器直接改）
 * + .practi/（历史仓库：链+节点池）。--base 给一篇现成 pop 文档则写入第一版；
 * 实例首次 push 才在 hub 诞生。目录已存在=拒绝。
 */
export async function runNew(opts: NewOpts): Promise<number> {
  const name = opts.positional[0];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) {
    console.error('usage: practi new <name> [--base <file.json>] [-m <msg>]   (name: letters/digits/dash)');
    return 1;
  }
  let baseDoc: Record<string, unknown> | undefined;
  if (opts.base !== undefined) {
    let text: string;
    try {
      text = fs.readFileSync(opts.base, 'utf8');
    } catch {
      console.error(`error: cannot read ${opts.base}`);
      return 1;
    }
    try {
      baseDoc = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      console.error(`error [E_JSON]: ${(e as Error).message}`);
      return 1;
    }
  }
  const repo = createRepo(process.cwd(), name, baseDoc, opts.message);
  if (repo === null) return 1;
  console.log(`created: ${name}/  (working file ${name}.json + history in .practi/)`);
  if (baseDoc !== undefined) {
    const root = repo.chain.commits[0]!.root;
    // 与 new/edit 时代同口径的子树门禁：本次内容的 E_* 拦下（链已停在空仓库，
    // 节点留给 gc——内容寻址幂等，不回滚文件）
    const loaded = loadWorkspace(repo.poolDir);
    const mine = subtreeFiles(loaded, root);
    const issues = validateWorkspace(loaded).filter((i) => mine.has(i.file));
    if (issues.length > 0) {
      for (const i of issues) console.error(`  ${i.code}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`);
      // 回滚诞生：链清空、工作文件撤掉——干净拒绝，不留「已上链却报未提交」的矛盾态
      repo.chain.commits = [];
      repo.chain.branches = { main: null };
      saveChain(repo);
      if (fs.existsSync(repo.filePath)) fs.unlinkSync(repo.filePath);
      console.error('error:  not committed — the folder is born empty; fix the document and `practi commit -m "..."` inside it');
      return 1;
    }
    console.log(`first revision: v1  ${shortHash(root)}  ${repo.chain.commits[0]!.message}`);
    printQualityHints(loaded, root);
    const note = describeRefresh(await refreshVectors(repo.poolDir, [...loaded.nodes.keys()].sort(), (h) => indexTextOf(h, loaded)));
    if (note !== null) console.error(note);
  }
  console.log(`next:    cd ${name} — edit ${name}.json, \`practi commit -m "..."\`, then \`practi push\``);
  return 0;
}

/** 与 search 同一口径的索引文本（全字段拼接） */
function indexTextOf(hash: string, ws: ReturnType<typeof loadWorkspace>): string {
  const e = nodeIndexFields(hash, ws.nodes.get(hash)!);
  return Object.values(e.fields).filter((v): v is string => typeof v === 'string').join('\n');
}
