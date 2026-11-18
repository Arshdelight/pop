import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 命令前版本检测（2026-11-18 需求）：10 分钟缓存三态（latest 静默 / update 提示 /
 * error 提示+重试指引）；失败也缓存不重复触发；--checkversion 强制重检（latest 也反馈）。
 * 网络（fetchUrl）与 npm registry 子进程（npmOut）全 mock——真实链路靠真跑验证。
 */

vi.mock('../src/net.js', () => ({
  fetchUrl: vi.fn(),
}));
vi.mock('../src/cmd/update.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/cmd/update.js')>();
  return { ...real, npmOut: vi.fn(() => 'https://registry.test') };
});

import { fetchUrl } from '../src/net.js';
import { npmOut } from '../src/cmd/update.js';
import { versionCheckNotify, type VersionCheckCache } from '../src/version-check.js';

const mockFetch = vi.mocked(fetchUrl);
const err = vi.spyOn(console, 'error').mockImplementation(() => {});

function reply(latest: string): { status: number; ok: boolean; bytes: Buffer } {
  return { status: 200, ok: true, bytes: Buffer.from(JSON.stringify({ 'dist-tags': { latest } })) };
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(__dirname, '.vc-'));
  mockFetch.mockReset();
  err.mockClear();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function cacheOf(): VersionCheckCache {
  return JSON.parse(fs.readFileSync(path.join(home, 'version-check.json'), 'utf8')) as VersionCheckCache;
}

function seedCache(cache: VersionCheckCache): void {
  fs.writeFileSync(path.join(home, 'version-check.json'), JSON.stringify(cache, null, 2));
}

describe('versionCheckNotify：TTL 缓存与三态提示', () => {
  it('无缓存 → 真检测：latest==current 静默但落缓存', async () => {
    const { CLI_VERSION } = await import('../src/version.js');
    mockFetch.mockResolvedValue(reply(CLI_VERSION));
    await versionCheckNotify({ dataDir: home });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
    expect(cacheOf().status).toBe('latest');
  });

  it('latest>current → update 提示（stderr，指向 practi update）', async () => {
    const { CLI_VERSION } = await import('../src/version.js');
    const bumped = bump(CLI_VERSION);
    mockFetch.mockResolvedValue(reply(bumped));
    await versionCheckNotify({ dataDir: home });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`update available: ${escapeRe(CLI_VERSION)} → ${escapeRe(bumped)}`)));
    expect(cacheOf()).toMatchObject({ status: 'update', latest: bumped });
  });

  it('网络失败 → error 缓存 + 提示（附 --checkversion 指引）；TTL 内复跑不再触发网络', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: registry unreachable'));
    await versionCheckNotify({ dataDir: home });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--checkversion'));
    expect(cacheOf().status).toBe('error');

    await versionCheckNotify({ dataDir: home }); // fresh error 缓存：提示但不重检
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
  });

  it('TTL 内 latest 缓存静默（零网络零输出）；update 缓存每次提示', async () => {
    const { CLI_VERSION } = await import('../src/version.js');
    seedCache({ checkedAt: new Date().toISOString(), status: 'latest', latest: CLI_VERSION });
    await versionCheckNotify({ dataDir: home });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();

    seedCache({ checkedAt: new Date().toISOString(), status: 'update', latest: '99.0.0' });
    await versionCheckNotify({ dataDir: home });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('缓存过期（>10 分钟）→ 重新检测', async () => {
    const { CLI_VERSION } = await import('../src/version.js');
    seedCache({ checkedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), status: 'error', reason: 'stale failure' });
    mockFetch.mockResolvedValue(reply(CLI_VERSION));
    await versionCheckNotify({ dataDir: home });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cacheOf().status).toBe('latest');
  });

  it('force（--checkversion）：无视 fresh 缓存强制重检，latest 也给确定反馈', async () => {
    const { CLI_VERSION } = await import('../src/version.js');
    seedCache({ checkedAt: new Date().toISOString(), status: 'latest', latest: CLI_VERSION });
    mockFetch.mockResolvedValue(reply(CLI_VERSION));
    await versionCheckNotify({ dataDir: home, force: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('is up to date'));
    // 刷回 error 后强制重试 → 恢复提示 + 指引
    seedCache({ checkedAt: new Date().toISOString(), status: 'error', reason: 'x' });
    mockFetch.mockResolvedValue(reply(CLI_VERSION));
    await versionCheckNotify({ dataDir: home, force: true });
    expect(cacheOf().status).toBe('latest');
  });

  it('npm registry 尊重 npm config（检测路径上取一次）', async () => {
    vi.mocked(npmOut).mockReturnValue('https://mirror.test');
    mockFetch.mockResolvedValue(reply('0.0.0'));
    await versionCheckNotify({ dataDir: home });
    expect(npmOut).toHaveBeenCalledWith(['config', 'get', 'registry']);
    expect(mockFetch.mock.calls[0]![0]).toMatch(/^https:\/\/mirror\.test\//);
  });
});

function bump(v: string): string {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b + 1}.${c}`;
}

function escapeRe(s: string): string {
  return s.replace(/\./g, '\\.');
}
