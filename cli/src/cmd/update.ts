import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CLI_VERSION } from '../version.js';

const PKG = '@arshdelight/practi';

export interface UpdateOpts {
  dataDir?: string;
}

/** npm.cmd only as a fallback — .cmd files need shell:true on modern Node (DEP0190) */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * How to invoke npm from this Node: DEP0190 (node ≥18.20/20.12) makes spawning
 * .cmd/.bat without shell:true throw EINVAL, so on Windows we bypass the shim
 * entirely and run the npm-cli.js that ships inside process.execPath's Node —
 * exactly what the npm.cmd shim does internally. Non-standard layouts without
 * that file fall back to npm.cmd with shell:true.
 */
export function npmInvocation(): { cmd: string; prefixArgs: string[]; shell: boolean } {
  if (process.platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return { cmd: process.execPath, prefixArgs: [cli], shell: false };
    return { cmd: NPM, prefixArgs: [], shell: true };
  }
  return { cmd: NPM, prefixArgs: [], shell: false };
}

function npmOut(args: string[]): string {
  const { cmd, prefixArgs, shell } = npmInvocation();
  const r = spawnSync(cmd, [...prefixArgs, ...args], { encoding: 'utf8', shell });
  return (r.stdout ?? '').trim();
}

/** 点分数值比较：a>b 返回 1，a<b 返回 -1，相等返回 0 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * practi update：向 registry 查 latest，比当前新就 npm install -g 自更新。
 * dev 安装（npm link 的符号链接）会被 registry 安装覆盖——检测到时先警告。
 * Windows 的安装是脱钩的后台进程：调用方 shell 正解释执行 practi 的 bin
 * shim（句柄开着），原地 npm 重写必失败；后台进程等本命令链退出后落盘，
 * 输出追加到临时目录日志（detached 进程不再共享 console，时序也不可靠）。
 */
export async function runUpdate(_opts: UpdateOpts): Promise<number> {
  const registry = npmOut(['config', 'get', 'registry']) || 'https://registry.npmjs.org';
  console.log(`checking ${registry} for ${PKG} …`);
  const res = await fetch(`${registry.replace(/\/+$/, '')}/${PKG.replace('/', '%2F')}`);
  if (!res.ok) {
    console.error(`error: registry returned HTTP ${res.status}`);
    return 1;
  }
  const meta = (await res.json()) as { 'dist-tags'?: { latest?: string } };
  const latest = meta['dist-tags']?.latest;
  if (!latest) {
    console.error('error: registry response carries no dist-tags.latest');
    return 1;
  }
  if (cmpSemver(latest, CLI_VERSION) <= 0) {
    console.log(`already up to date: ${CLI_VERSION} (registry latest ${latest})`);
    return 0;
  }

  const prefix = npmOut(['prefix', '-g']);
  const installedDir = prefix ? path.join(prefix, 'node_modules', PKG) : '';
  if (installedDir && fs.existsSync(installedDir) && fs.lstatSync(installedDir).isSymbolicLink()) {
    console.error(`warning: ${installedDir} is a linked development install — updating replaces the link with a registry install`);
  }

  console.log(`updating: ${CLI_VERSION} → ${latest}`);
  const { cmd, prefixArgs, shell } = npmInvocation();
  const installArgs = [...prefixArgs, 'install', '-g', `${PKG}@${latest}`];
  if (process.platform === 'win32') {
    const log = path.join(os.tmpdir(), 'practi-update.log');
    const out = fs.openSync(log, 'a');
    try {
      const child = spawn(cmd, installArgs, { detached: true, stdio: ['ignore', out, out], shell });
      child.unref();
    } catch (e) {
      fs.closeSync(out);
      console.error(`error: could not start the background installer — ${(e as Error).message}`);
      console.error(`run it manually:  npm install -g ${PKG}@${latest}`);
      return 1;
    }
    fs.closeSync(out);
    console.log(`installing ${latest} in the background — log: ${log}`);
    console.log(`verify with: practi --version`);
    return 0;
  }
  const r = spawnSync(cmd, installArgs, { stdio: 'inherit', shell });
  if (r.status !== 0) {
    console.error('error: npm install failed — run it manually:');
    console.error(`  npm install -g ${PKG}@${latest}`);
    return 1;
  }
  console.log(`updated to ${latest} (takes effect on the next run)`);
  return 0;
}
