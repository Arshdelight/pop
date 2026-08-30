import fs from 'node:fs';
import path from 'node:path';

/**
 * 登录凭证（refresh/access token 等），独立于 workspace 状态（practi.json）存放：
 * 数据目录是 POP workspace，可能在 git 仓库里，practi.json 不应携带密钥。
 * 存在 $dataDir/practi.auth.json；POSIX 上 chmod 600（Windows 依赖用户级目录权限）。
 * 旧名 pop.auth.json 仍可读（读旧写新）——改名前的登录不失效。
 */

export const AUTH_FILE = 'practi.auth.json';
const LEGACY_AUTH_FILE = 'pop.auth.json';

export interface Credentials {
  schema: 1;
  /** OAuth client id（DCR 注册所得，保存用于后续 refresh/revoke） */
  client_id: string;
  /** audience（RFC 8707 resource）= remote origin + /cli */
  resource: string;
  /** 已授予的 scope（空格分隔，来自授权页勾选） */
  scope?: string;
  /** 授权时展示的 client 名（可选，仅展示用） */
  client_name?: string;
  /** access token（1h 短效，可能已过期） */
  access_token?: string;
  /** access token 过期时刻（epoch ms） */
  expires_at?: number;
  /** refresh token（长效，rotation——用一次换新对后必须回写） */
  refresh_token: string;
}

export function authPath(dataDir: string): string {
  return path.join(dataDir, AUTH_FILE);
}

function findAuthFile(dataDir: string): string | null {
  const p = path.join(dataDir, AUTH_FILE);
  if (fs.existsSync(p)) return p;
  const legacy = path.join(dataDir, LEGACY_AUTH_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** 实际存放凭证的文件（practi.auth.json，或改名前的 pop.auth.json）——显示用 */
export function existingAuthFile(dataDir: string): string | null {
  return findAuthFile(dataDir);
}

export function loadCredentials(dataDir: string): Credentials | null {
  const p = findAuthFile(dataDir);
  if (p === null) return null;
  try {
    const rec: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof rec === 'object' && rec !== null && typeof (rec as Record<string, unknown>).refresh_token === 'string') {
      return rec as Credentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(dataDir: string, creds: Credentials): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = authPath(dataDir);
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + '\n', 'utf8');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      // chmod 失败不阻塞写入（如某些只读挂载）
    }
  }
}

export function deleteCredentials(dataDir: string): void {
  for (const f of [authPath(dataDir), path.join(dataDir, LEGACY_AUTH_FILE)]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** access token 是否仍有效（未过期 + 有值） */
export function isAccessTokenFresh(creds: Credentials): boolean {
  return !!creds.access_token && !!creds.expires_at && creds.expires_at > Date.now() + 30_000;
}
