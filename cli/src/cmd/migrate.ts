import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultDataDir, pointerPath, readPointer, writePointer } from '../state.js';
import { isInitialized } from '../workspace.js';

export interface MigrateOpts {
  dataDir?: string;
  positional: string[];
  /** keep the old directory as <dir>.bak-<timestamp> instead of removing it */
  keep?: boolean;
}

/** Convention location: where a fresh install's discovery chain lands (~/.practi). */
function conventionDir(): string {
  return path.join(os.homedir(), '.practi');
}

/** child is inside parent (or equal) after resolution — guards against migrating
 *  into a subdirectory of the source (rename would carry the copy away) or vice
 *  versa (cpSync would recurse into itself). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** rel-path → sha256 of every file under root (the whole workspace: nodes,
 *  blobs, practi.json, practi.auth.json, practice.yaml — nothing is picked,
 *  nothing is missed). */
function fingerprint(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else {
        const bytes = fs.readFileSync(path.join(dir, entry.name));
        out.set(rel, crypto.createHash('sha256').update(bytes).digest('hex'));
      }
    }
  };
  visit(root, '');
  return out;
}

/**
 * practi migrate [path] [--keep]：把整个 workspace 剪切到新数据目录，四步协议——
 *   pre      初始化/同名/占用/嵌套/指针一致性检查，任何一项不过即不动手
 *   copy     整目录复制（含凭证 practi.auth.json 与 practi.json）
 *   verify   源/目标逐文件 sha256 比对；失败即清除半成品——搬家未发生
 *   handover 剪切语义：verify 已证明新副本与源逐字节一致，旧目录直接删除；
 *            --keep 反转为改名 <dir>.bak-<timestamp> 留底（与 edit --keep 同族：
 *            默认清理，显式保留）
 *   record   新家在约定位置（无参 → ~/.practi）则发现链天然命中、不写指针；
 *            否则写 ~/.practi-home 指针（自举约束：位置不能记在 workspace 里）
 * verify 通过而 handover 失败 = 新家完整、旧家未动：双库并存，提示手动收尾，
 * 绝不回滚已验证的数据。
 */
export function runMigrate(opts: MigrateOpts): number {
  const from = path.resolve(opts.dataDir ?? defaultDataDir());
  const to = opts.positional[0] ? path.resolve(opts.positional[0]) : conventionDir();
  const toIsConvention = to === conventionDir();

  // ---- pre ----
  if (!isInitialized(from)) {
    console.error(`error: ${from} is not an initialized practi data directory (no practi.json + practice.yaml)`);
    return 1;
  }
  if (from === to) {
    console.error(`error: already there — ${to} is the current data directory`);
    return 1;
  }
  if (isInside(from, to) || isInside(to, from)) {
    console.error(`error: ${to} overlaps ${from} — pick a location outside the workspace`);
    return 1;
  }
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
    console.error(`error: target ${to} exists and is not empty`);
    return 1;
  }
  const pointer = readPointer();
  if (toIsConvention && pointer) {
    console.error(`error: ~/.practi-home currently points to ${pointer} — migrating to the convention location`);
    console.error(`       contradicts that home. Remove ${pointerPath()} first, or migrate explicitly: practi migrate <path>`);
    return 1;
  }

  // ---- copy ----
  try {
    fs.cpSync(from, to, { recursive: true });
  } catch (e) {
    fs.rmSync(to, { recursive: true, force: true });
    console.error(`error: copy failed — ${(e as Error).message}`);
    return 1;
  }

  // ---- verify ----
  let src: Map<string, string>;
  let dst: Map<string, string>;
  try {
    src = fingerprint(from);
    dst = fingerprint(to);
  } catch (e) {
    fs.rmSync(to, { recursive: true, force: true });
    console.error(`error: verification could not run — ${(e as Error).message} (target removed, nothing moved)`);
    return 1;
  }
  const same = src.size === dst.size && [...src].every(([rel, hash]) => dst.get(rel) === hash);
  if (!same) {
    fs.rmSync(to, { recursive: true, force: true });
    console.error('error: verification failed — target differs from source (target removed, nothing moved)');
    return 1;
  }

  // ---- handover ----
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const backup = `${from}.bak-${stamp}`;
  try {
    if (opts.keep === true) {
      fs.renameSync(from, backup);
    } else {
      fs.rmSync(from, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`error: could not remove the old directory (${(e as Error).message}).`);
    console.error(`       The verified copy is complete at ${to}; resolve the old directory by hand, then re-point if needed.`);
    return 1;
  }

  // ---- record ----
  console.log(`migrated:  ${from} → ${to}  (${src.size} files verified)`);
  if (opts.keep === true) {
    console.log(`backup:    ${backup}  (delete it yourself once you trust the new location)`);
  } else {
    console.log(`removed:   ${from}  (verified copy in place — pass --keep next time to retain a .bak)`);
  }
  if (toIsConvention) {
    console.log(`next run:  the default data dir resolves to ${to} (convention location)`);
  if (process.env.PRACTI_HOME || process.env.POP_HOME) {
    console.error(`warning:  $${process.env.PRACTI_HOME ? 'PRACTI_HOME' : 'POP_HOME'} is set and OUTRANKS the convention — unset it or repoint it at ${to}, or every bare command keeps resolving to the deleted directory`);
  }
  } else {
    try {
      const previous = readPointer();
      writePointer(to);
      console.log(`pointer:   ${pointerPath()}${previous ? ` (${previous} →)` : ''} now points to ${to} — the next run picks it up`);
    } catch (e) {
      console.error(`warning: could not write ${pointerPath()} (${(e as Error).message})`);
      console.error(`         the workspace lives at ${to} — export $PRACTI_HOME or fix the write, or every bare command will miss it`);
    }
  }
  return 0;
}
