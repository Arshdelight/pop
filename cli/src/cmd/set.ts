import { normalizeHashRef, patchInstanceMetadata } from '../client.js';
import { defaultDataDir, remoteUrl } from '../state.js';
import { parseCloneRef } from './clone.js';

export interface SetOpts {
  dataDir?: string;
  positional: string[];
  name?: string;
  description?: string;
  refines?: string;
}

/**
 * practi set <owner>/<name> --name <新名> | --description <文本> | --refines <hash>：
 * 直接改 hub 实例元数据（PATCH）。只发用户给了的字段；`--description ""` 与
 * `--refines ""` 表示清空。成功打印改了什么；改名成功补打新地址。
 */
export async function runSet(opts: SetOpts): Promise<number> {
  const usage = 'usage: practi set <owner>/<name> [--name <new-name>] [--description <text>] [--refines <hash>]   ("" clears description / refines)';
  const parsed = opts.positional[0] !== undefined ? parseCloneRef(opts.positional[0]) : null;
  if (!parsed || parsed.owner === undefined) {
    console.error(parsed === null && opts.positional[0] !== undefined && opts.positional[0].includes('/')
      ? 'error: a hub practice needs its owner — `practi set <owner>/<name>`'
      : 'error: practi set addresses a hub instance — `practi set <owner>/<name>` with at least one of --name/--description/--refines');
    console.error(usage);
    return 1;
  }
  const patch: Record<string, unknown> = {};
  if (opts.name !== undefined) patch.name = opts.name;
  if (opts.description !== undefined) patch.description = opts.description;
  if (opts.refines === '') {
    patch.refines = null; // hub 侧 null 与空串都表示清除
  } else if (opts.refines !== undefined) {
    const ref = normalizeHashRef(opts.refines);
    if (ref === null) {
      console.error('error: --refines expects a sha256 hash (sha256:-prefixed or bare 64-hex) of the practice this one improves, or "" to clear');
      return 1;
    }
    patch.refines = ref;
  }
  if (Object.keys(patch).length === 0) {
    console.error('error: nothing to set — give at least one of --name/--description/--refines');
    console.error(usage);
    return 1;
  }
  const { owner, name } = parsed;
  const dataDir = opts.dataDir ?? defaultDataDir();
  const remote = remoteUrl(dataDir);
  await patchInstanceMetadata(dataDir, remote, owner, name, patch);

  const changed: string[] = [];
  if (patch.name !== undefined) changed.push(`name → ${patch.name as string}`);
  if (patch.description !== undefined) changed.push(patch.description === '' ? 'description cleared' : `description → ${patch.description}`);
  if (patch.refines !== undefined) changed.push(patch.refines === null ? 'refines cleared' : `refines → ${patch.refines as string}`);
  console.log(`updated ${owner}/${name}`);
  for (const line of changed) console.log(`  ${line}`);
  if (patch.name !== undefined) console.log(`new address: ${owner}/${patch.name as string}`);
  return 0;
}
