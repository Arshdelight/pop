import fs from 'node:fs';
import { loadWorkspace, validateWorkspace } from '@arshdelight/pop-sdk';
import { createRepo, saveChain } from '../practice.js';
import { printQualityHints } from '../quality.js';
import { shortHash } from '../render.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { authedFetch, fetchMyUsername, hubErrorMessage } from '../client.js';
import { stageRemoteDoc } from './commit.js';
import { subtreeFiles } from '../workspace.js';

export interface NewOpts {
  positional: string[];
  /** --base <file.json>：用一篇现成的 pop 文档诞生第一版（缺省=空仓库） */
  base?: string;
  /** --file <path|->：直接在 hub 上诞生实例并落第一版，不建任何本地文件夹 */
  file?: string;
  message?: string;
  /** 配置家（远程模式读凭据与 remote）；本地模式不用 */
  dataDir?: string;
}

const NEW_USAGE = 'usage: practi new <name> [--base <file.json>] [-m <msg>]   (birth a practice folder in cwd)   |   practi new <name> --file <path|-> [-m <msg>]   (create it on the hub — no local folder)';

/**
 * practi new <name> [--base <file.json>] [-m <msg>]：
 * 在 cwd 诞生实例文件夹 <name>/——工作文件 <name>.json（pop 本体，任何编辑器直接改）
 * + .practi/（历史仓库：链+节点池）。--base 给一篇现成 pop 文档则写入第一版；
 * 实例首次 push 才在 hub 诞生。目录已存在=拒绝。
 * --file <path|->：不经本地文件夹——POST /instances 私有实例 + main 落第一版；
 * 与 --base 互斥；重名 409 指去 `practi commit`，实例建成而首版失败则实例保留可重试。
 */
export async function runNew(opts: NewOpts): Promise<number> {
  const name = opts.positional[0];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) {
    console.error(NEW_USAGE);
    console.error('       (name: letters/digits/dash)');
    return 1;
  }
  if (opts.file !== undefined && opts.base !== undefined) {
    console.error('error: --file and --base are mutually exclusive — --file births the practice on the hub, --base in a local folder');
    console.error(NEW_USAGE);
    return 1;
  }
  if (opts.file !== undefined) {
    return newOnHub(name, opts.file, opts.message, opts.dataDir);
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
  }
  console.log(`next:    cd ${name} — edit ${name}.json, \`practi commit -m "..."\`, then \`practi push\``);
  return 0;
}

/** practi new <name> --file：hub 上诞生私有实例并落第一版（不建任何本地文件夹）。
 *  上传前校验与 commit --file 同一套（stageRemoteDoc，临时 workspace，E_BLOB_MISSING
 *  交给 hub）；W 提示在成功后打（临时目录随 finally 删，提示趁目录还在打）。 */
async function newOnHub(name: string, file: string, messageOpt: string | undefined, dataDirOpt?: string): Promise<number> {
  const dataDir = dataDirOpt ?? defaultDataDir();
  const remote = remoteUrl(dataDir);

  const staged = stageRemoteDoc(file);
  if (staged === null) return 1;
  const { root, ws: loaded, document, dispose } = staged;
  try {
    const message = messageOpt ?? (typeof document.name === 'string' ? document.name : '');

    // 诞生私有实例（首版失败时实例留着——不会重复建）
    const mk = await authedFetch(dataDir, remote, '/api/v1/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, visibility: 'PRIVATE' }),
    });
    const mkBody = (await mk.json().catch(() => ({}))) as Record<string, unknown>;
    if (!mk.ok) {
      if (mk.status === 409 || mkBody.code === 'E_DUPLICATE') {
        const me = await fetchMyUsername(dataDir, remote);
        console.error(`error: an instance named "${name}" already exists under ${me} — add to it with \`practi commit ${me}/${name} --file <path|->\``);
        return 1;
      }
      console.error(`error: creating the instance on the hub — ${hubErrorMessage(mk.status, mkBody)}`);
      return 1;
    }
    if (typeof mkBody.owner !== 'string' || mkBody.owner === '') {
      console.error('error: the hub accepted the instance but did not name its owner (hub version too old for the two-software model?)');
      return 1;
    }
    const owner = mkBody.owner;
    const address = `${owner}/${name}`;

    const res = await authedFetch(dataDir, remote, `/api/v1/instances/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/main/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document, message, parent_hash: null }),
    });
    const resBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      console.error(
        `error: the instance ${address} was created on the hub, but its first revision failed — ${hubErrorMessage(res.status, resBody)}\n` +
          `  retry with \`practi commit ${address} --file <path|->\` (the instance is kept; it will not be created twice)`
      );
      return 1;
    }
    const seq = typeof resBody.seq === 'number' ? resBody.seq : 1;
    console.log(`created on the hub: ${address}  (PRIVATE)`);
    console.log(`pushed:  ${address}@main v${seq}  ${shortHash(root)}  ${message}`);
    console.log(`  invisible to others — request publication with: practi visibility ${address} public`);
    printQualityHints(loaded, root);
    return 0;
  } finally {
    dispose();
  }
}
