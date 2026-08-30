import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_VERSION } from '../version.js';

const PKG = 'practi';

export interface UpdateOpts {
  dataDir?: string;
}

/** Windows 上 npm 是 npm.cmd（.cmd 必须免 shell 调用，否则触发 DEP0190） */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npmOut(args: string[]): string {
  const r = spawnSync(NPM, args, { encoding: 'utf8' });
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
  const r = spawnSync(NPM, ['install', '-g', `${PKG}@${latest}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('error: npm install failed — run it manually:');
    console.error(`  npm install -g ${PKG}@${latest}`);
    return 1;
  }
  console.log(`updated to ${latest} (takes effect on the next run)`);
  return 0;
}
