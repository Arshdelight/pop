import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSkill, importSkill, PracticeError, resolveNodeRef } from '@arshdelight/pop-sdk';
import { defaultDataDir, loadState, saveState } from '../state.js';
import { openWorkspace } from '../workspace.js';

/**
 * pop skill 子命令：
 * - install|update|uninstall：管理随 CLI 打包的 use-pop agent skill。
 *   源：包内 skills/use-pop（package.json files 已含）。仓库根 skills/use-pop 是标准
 *   （npx skills 从仓库安装），CI 锁两份逐字节一致。
 *   注意：该 skill 目录本身就是一份 POP 的导出物（SKILL.md 是投影，pop.doc.json
 *   是源文档）——维护时改 POP 再重新 export，不手改 SKILL.md。
 *   目标：默认 ~/.agents/skills（跨 agent 约定目录，与 npx skills 的落点相同），
 *   --dir <skills-dir> 覆盖；安装形态 <skills-dir>/use-pop/SKILL.md。
 *   install 幂等同步（含清理源里已不存在的陈旧文件）；update 要求已安装；uninstall 删整个目录。
 * - import|export：skill ⇄ POP 转换（spec §1/§8）。
 *   export 把 workspace 里的 POP 投影成可安装的技能目录（SKILL.md + 附件 +
 *   pop.doc.json sidecar）；import 是它的逆运算——sidecar 精确回放（附件文件
 *   重新入库并验哈希），无 sidecar 的外来技能目录被拒绝（E_NO_SIDECAR）：
 *   外来 skill 靠重新撰写进入 POP，不做机械压平。
 */

const SKILL_NAME = 'use-pop';

export interface SkillOpts {
  action: 'install' | 'update' | 'uninstall' | 'import' | 'export';
  dir?: string;
  /** import/export 的 pop 数据目录（默认 $POP_HOME / %APPDATA%\pop / ~/.pop） */
  dataDir?: string;
  /** import：技能源目录；export：节点引用（hash 或唯一前缀） */
  positional?: string;
}

function sourceDir(): string {
  // dist/cmd/skill.js → 包根 → skills/use-pop（源码运行与 npm 安装布局同构）
  return fileURLToPath(new URL('../../skills/use-pop', import.meta.url));
}

function listFiles(dir: string, base: string = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function sameBytes(a: string, b: string): boolean {
  const fa = fs.readFileSync(a);
  const fb = fs.readFileSync(b);
  return fa.length === fb.length && fa.equals(fb);
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** 把包内 skill 目录同步到 target：写入缺失/有差异的文件，清理源里已不存在的陈旧文件 */
function syncTo(src: string, target: string): { written: number; unchanged: number; pruned: number } {
  const files = listFiles(src);
  const want = new Set(files);
  let written = 0;
  let unchanged = 0;
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(target, rel);
    if (fs.existsSync(to) && sameBytes(from, to)) {
      unchanged++;
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`  ${rel}  written (${kb(fs.statSync(from).size)})`);
    written++;
  }
  let pruned = 0;
  if (fs.existsSync(target)) {
    for (const rel of listFiles(target)) {
      if (!want.has(rel)) {
        fs.rmSync(path.join(target, rel));
        console.log(`  ${rel}  pruned (no longer in the package)`);
        pruned++;
      }
    }
  }
  return { written, unchanged, pruned };
}

export function runSkill(opts: SkillOpts): number {
  if (opts.action === 'import') return runSkillImport(opts);
  if (opts.action === 'export') return runSkillExport(opts);

  const skillsDir = opts.dir ? path.resolve(opts.dir) : path.join(os.homedir(), '.agents', 'skills');
  const target = path.join(skillsDir, SKILL_NAME);

  if (opts.action === 'uninstall') {
    if (!fs.existsSync(target)) {
      console.error(`error: nothing to remove — ${target} does not exist`);
      return 1;
    }
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
      console.error(`error: ${target} exists but has no SKILL.md — does not look like the ${SKILL_NAME} skill; remove it manually`);
      return 1;
    }
    fs.rmSync(target, { recursive: true });
    console.log(`removed:  ${SKILL_NAME} → ${target}`);
    return 0;
  }

  const src = sourceDir();
  if (!fs.existsSync(src)) {
    console.error(`error: bundled skill not found at ${src} — the cli package is broken; reinstall it (npm install -g @arshdelight/pop-cli)`);
    return 1;
  }
  if (opts.action === 'update' && !fs.existsSync(target)) {
    console.error(`error: ${SKILL_NAME} is not installed in ${skillsDir} — run \`pop skill install\` first`);
    return 1;
  }

  const existed = fs.existsSync(target);
  const { written, unchanged, pruned } = syncTo(src, target);
  if (written === 0 && pruned === 0) {
    console.log(`up to date: ${SKILL_NAME} → ${target} (${unchanged} file(s), nothing changed)`);
  } else {
    const verb = existed ? 'updated' : 'installed';
    console.log(`${verb}: ${SKILL_NAME} → ${target} (${written} written, ${unchanged} unchanged${pruned > 0 ? `, ${pruned} pruned` : ''})`);
  }
  return 0;
}

/** 技能目录名兜底：非 ASCII 名（如中文）slug 后为空 → 用 hash 前缀 */
function slugOrHash(name: string, hash: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug !== '' ? slug : hash.slice('sha256:'.length, 'sha256:'.length + 12);
}

/** pop skill import <dir>：回放 `pop skill export` 导出的目录（sidecar 精确复放，附件重新入库）+ 注册 direct */
function runSkillImport(opts: SkillOpts): number {
  if (!opts.positional) {
    console.error('usage: pop skill import <skill-dir> [--data-dir <dir>]');
    return 1;
  }
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : defaultDataDir();
  const skillDir = path.resolve(opts.positional);
  const ws = openWorkspace(dataDir);

  const warns: string[] = [];
  let res;
  try {
    res = importSkill(ws, skillDir, { warn: (m) => warns.push(m) });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`import failed: ${skillDir} — ${detail}`);
    if (e instanceof PracticeError && e.hint) console.error(`  hint: ${e.hint}`);
    return 1;
  }

  const state = loadState(dataDir);
  if (!state.direct.includes(res.root)) {
    state.direct.push(res.root);
    saveState(dataDir, state);
  }

  console.log(`imported:  ${res.root}  (${res.count} node(s))  [direct]`);
  console.log(`  source:   ${res.sidecarUsed ? 'pop.doc.json sidecar replay (byte-identical hash)' : 'edited SKILL.md body (sidecar out of sync — new hash)'}`);
  for (const w of warns) console.log(`  warning:  ${w}`);
  return 0;
}

/** pop skill export <ref> [--dir <out>]：POP → 技能目录（SKILL.md 投影 + 附件 + sidecar） */
function runSkillExport(opts: SkillOpts): number {
  if (!opts.positional) {
    console.error('usage: pop skill export <ref> [--dir <out-dir>] [--data-dir <dir>]');
    return 1;
  }
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : defaultDataDir();
  const ws = openWorkspace(dataDir);

  let rootHash: string;
  try {
    rootHash = resolveNodeRef(ws, opts.positional);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`export failed: ${opts.positional} — ${detail}`);
    return 1;
  }
  const name = ws.nodes.get(rootHash)?.name ?? rootHash;
  const outDir = opts.dir ? path.resolve(opts.dir) : path.resolve(process.cwd(), slugOrHash(name, rootHash));

  let res;
  try {
    res = exportSkill(ws, opts.positional, outDir);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`export failed: ${rootHash} — ${detail}`);
    return 1;
  }

  console.log(`exported:  ${res.rootHash} → ${outDir}`);
  console.log(`  SKILL.md  (projection of the document)`);
  for (const f of res.files) console.log(`  ${f}`);
  console.log(`  pop.doc.json  (sidecar — re-import replays this exact document, lossless round-trip)`);
  return 0;
}
