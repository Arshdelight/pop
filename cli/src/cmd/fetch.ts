import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { fetchRemoteDoc, normalizeHashRef } from '../client.js';

export interface FetchOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi fetch <owner>/<name> <hash>：从指定实例拉取一份修订存进本地 pop 库（direct）。
 * 内容访问带仓库上下文（GitHub blobs 同构，2026-10-19 拍板）——同一 root 可属多个实例，
 * 全局按哈希取内容的口子已在 hub 退役。
 * - 必须全哈希（sha256: 前缀可选；前缀短哈希没法对 hub 反查，宁拒勿猜）
 * - 可见性随实例：公开实例任何人可拉；私有实例仅 owner/admin
 * - 入库前验算内容寻址（fetchRemoteDoc 过闸），注册为 direct
 */
export async function runFetch(opts: FetchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const [repoRef, rawRef] = opts.positional;
  const repoMatch = repoRef ? /^([\w-]+)\/([\w-]+)$/.exec(repoRef) : null;
  if (!repoMatch) {
    console.error('usage: practi fetch <owner>/<name> <hash>   (full sha256 root hash; pulls one revision of that instance into your local registry)');
    return 1;
  }
  const [, owner, name] = repoMatch;
  const full = rawRef ? normalizeHashRef(rawRef) : null;
  if (!full) {
    console.error('usage: practi fetch <owner>/<name> <hash>   (full sha256 root hash; pulls one revision of that instance into your local registry)');
    return 1;
  }

  let result;
  try {
    result = await fetchRemoteDoc(dataDir, state.remote.url, owner, name, full);
  } catch (e) {
    console.error(`fetch failed: ${(e as Error).message}`);
    return 1;
  }

  const next = loadState(dataDir);
  const added = claimDirect(next, result.rootHash);
  saveState(dataDir, next);
  console.log(`fetched: ${result.rootHash}  (${result.status})  [direct${added ? '' : ', already registered'}]`);
  return 0;
}
