import { claimDirect, defaultDataDir, loadState, saveState } from '../state.js';
import { fetchRemoteDoc, normalizeHashRef } from '../client.js';

export interface FetchOpts {
  dataDir?: string;
  positional: string[];
}

/**
 * practi fetch <hash>：从 hub 拉取单个 POP 存进本地 pop 库（direct）——git 无此对应的
 * 特例：内容寻址让「一个对象」本身可寻址，pull（仓库内同步）之外允许单取一件。
 * - 必须全哈希（sha256: 前缀可选；前缀短哈希没法对 hub 反查，宁拒勿猜）
 * - 可见性随 hub：公开内容任何人可拉；私有内容仅实例利益方（登录账号 own 的实例）
 * - 入库前验算内容寻址（fetchRemoteDoc 过闸），注册为 direct
 */
export async function runFetch(opts: FetchOpts): Promise<number> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const state = loadState(dataDir);
  if (!state.remote) {
    console.error('error: no remote configured — run `practi remote set <url>` first');
    return 1;
  }
  const ref = opts.positional[0];
  const full = ref ? normalizeHashRef(ref) : null;
  if (!full) {
    console.error('usage: practi fetch <hash>   (full sha256 root hash; pulls one POP from the hub into your local registry)');
    return 1;
  }

  let result;
  try {
    result = await fetchRemoteDoc(dataDir, state.remote.url, full);
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
