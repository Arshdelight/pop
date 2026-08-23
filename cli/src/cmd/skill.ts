import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * pop skill install|update|uninstall：管理随 CLI 打包的 use-pop agent skill。
 * - 源：包内 skills/use-pop（package.json files 已含）。仓库根 skills/use-pop 是标准
 *   （npx skills 从仓库安装），CI 锁两份逐字节一致。
 * - 目标：默认 ~/.agents/skills（跨 agent 约定目录，与 npx skills 的落点相同），
 *   --dir <skills-dir> 覆盖；安装形态 <skills-dir>/use-pop/SKILL.md。
 * - install 幂等同步（含清理源里已不存在的陈旧文件）；update 要求已安装；uninstall 删整个目录。
 */

const SKILL_NAME = 'use-pop';

export interface SkillOpts {
  action: 'install' | 'update' | 'uninstall';
  dir?: string;
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
