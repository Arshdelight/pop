import fs from 'node:fs';
import { fetchUrl } from './net.js';
import { defaultDataDir } from './state.js';
import { CLI_VERSION } from './version.js';
import { cmpSemver, clearVersionCheckCache, npmOut, PKG, versionCheckCachePath } from './cmd/update.js';

/**
 * 命令前注入的自动版本检测（2026-11-18 需求）：
 * - 缓存 = 配置家下 version-check.json，TTL 10 分钟；TTL 内按缓存态提示——
 *   latest 静默、update 提示、error 提示（附 --checkversion 重试指引）
 * - TTL 外（或 --checkversion 强制）做一次网络检测并回写缓存；**失败也是结果**，
 *   照常缓存——10 分钟内不重复触发（离线/断网时不至于每条命令都等超时）
 * - 强制检测是显式动作：latest 也给确定反馈（普通路径 latest 静默）
 * - 一切输出走 stderr（不污染 --json 的 stdout）；任何异常吞掉，绝不阻塞命令
 * 网络走 net.ts#fetchUrl（系统代理通道，同 blob URL 导入口径）；registry 尊重
 * npm config（npmOut 只在真实检测路径上起一次同步子进程，TTL 内零开销）。
 */

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;

export type VersionCheckStatus = 'latest' | 'update' | 'error';

export interface VersionCheckCache {
  checkedAt: string; // ISO
  status: VersionCheckStatus;
  latest?: string;
  reason?: string; // status=error 时的失败原因
}

function cachePath(dataDir: string): string {
  return versionCheckCachePath(dataDir);
}

function readCache(dataDir: string): VersionCheckCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8')) as VersionCheckCache;
    if (typeof raw.checkedAt !== 'string') return null;
    if (raw.status !== 'latest' && raw.status !== 'update' && raw.status !== 'error') return null;
    return raw;
  } catch {
    return null; // 缺失/损坏都当无缓存（触发一次重检即自愈）
  }
}

function writeCache(dataDir: string, cache: VersionCheckCache): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch { /* 写失败只影响下次重复检测，不阻塞命令 */ }
}

function isFresh(cache: VersionCheckCache): boolean {
  const at = Date.parse(cache.checkedAt);
  return Number.isFinite(at) && Date.now() - at < TTL_MS;
}

/** 真网络检测一次：三态都返回（失败也是结果，交给调用方缓存） */
async function checkOnce(): Promise<VersionCheckCache> {
  const checkedAt = new Date().toISOString();
  try {
    const registry = npmOut(['config', 'get', 'registry']) || 'https://registry.npmjs.org';
    const res = await fetchUrl(`${registry.replace(/\/+$/, '')}/${PKG.replace('/', '%2F')}`, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
    });
    if (res.status !== 200) {
      return { checkedAt, status: 'error', reason: `registry returned HTTP ${res.status}` };
    }
    const meta = JSON.parse(res.bytes.toString('utf8')) as { 'dist-tags'?: { latest?: string } };
    const latest = meta['dist-tags']?.latest;
    if (!latest) return { checkedAt, status: 'error', reason: 'registry response carries no dist-tags.latest' };
    if (cmpSemver(latest, CLI_VERSION) > 0) return { checkedAt, status: 'update', latest };
    return { checkedAt, status: 'latest', latest };
  } catch (e) {
    return { checkedAt, status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

function notify(cache: VersionCheckCache, force: boolean, dataDir: string): void {
  // 陈旧 update 缓存守卫：update 命令落地新版后，TTL 内残留缓存的 latest 已 ≤ 当前版
  // （典型如「update available: 0.23.0 → 0.23.0」）——失效清缓存并静默
  if (cache.status === 'update' && cache.latest && cmpSemver(cache.latest, CLI_VERSION) <= 0) {
    clearVersionCheckCache(dataDir);
    return;
  }
  if (cache.status === 'update') {
    console.error(`update available: ${CLI_VERSION} → ${cache.latest} — run \`practi update\``);
  } else if (cache.status === 'error') {
    console.error(`practi version check failed: ${cache.reason ?? 'unknown'} — retry with --checkversion`);
  } else if (force) {
    console.error(`practi ${CLI_VERSION} is up to date (registry latest ${cache.latest ?? CLI_VERSION})`);
  }
}

/** index.ts 命令分发前注入；force = --checkversion / --check-version。
 *  PRACTI_NO_VERSION_CHECK=1 整体禁用（脚本/CI/测试要纯净输出时用）。 */
export async function versionCheckNotify(opts: { dataDir?: string; force?: boolean } = {}): Promise<void> {
  try {
    if (process.env.PRACTI_NO_VERSION_CHECK === '1') return;
    const dataDir = opts.dataDir ?? defaultDataDir();
    const cached = readCache(dataDir);
    if (opts.force !== true && cached && isFresh(cached)) {
      notify(cached, false, dataDir);
      return;
    }
    const result = await checkOnce();
    writeCache(dataDir, result);
    notify(result, opts.force === true, dataDir);
  } catch { /* 双保险：检测链路任何意外都不影响命令执行 */ }
}
