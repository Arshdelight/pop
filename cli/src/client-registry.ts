import fs from 'node:fs';
import path from 'node:path';

/**
 * 已登记 OAuth client 的本地账本（practi.client.json）：DCR 登记一次就按 remote 记住
 * client_id，之后的 login 复用，不再每次登录都往 hub 新增一条登记。
 * 登记是这台机器的资产，不属于某次会话——logout 只删凭据（practi.auth.json），不动这里；
 * 只有 hub 确认不再认这条登记（client-info 404 "Client not found"）才丢弃。
 * 文件读不到或解析失败一律当作没有登记（不抛错）。
 */

export const CLIENT_FILE = 'practi.client.json';

interface RegistryEntry {
  client_id: string;
  registered_at: string;
}

interface RegistryFile {
  schema: 1;
  clients: Record<string, RegistryEntry>;
}

function registryPath(dataDir: string): string {
  return path.join(dataDir, CLIENT_FILE);
}

function readRegistry(dataDir: string): RegistryFile | null {
  try {
    const rec: unknown = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8'));
    if (typeof rec !== 'object' || rec === null) return null;
    const clients = (rec as { clients?: unknown }).clients;
    if (typeof clients !== 'object' || clients === null || Array.isArray(clients)) return null;
    return { schema: 1, clients: clients as Record<string, RegistryEntry> };
  } catch {
    return null;
  }
}

/** 该 remote 登记过的 client_id；没有 / 文件缺失 / 解析失败 → null */
export function loadRegisteredClientId(dataDir: string, remote: string): string | null {
  const entry = readRegistry(dataDir)?.clients[remote];
  return typeof entry?.client_id === 'string' && entry.client_id !== '' ? entry.client_id : null;
}

/** 记下一条登记（写法照 saveCredentials：目录不存在就建；同 remote 覆盖旧条目） */
export function saveRegisteredClientId(dataDir: string, remote: string, clientId: string): void {
  const reg = readRegistry(dataDir) ?? { schema: 1, clients: {} };
  reg.clients[remote] = { client_id: clientId, registered_at: new Date().toISOString() };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(registryPath(dataDir), JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

/** 丢弃一条登记；本来就没有就不动文件 */
export function forgetRegisteredClientId(dataDir: string, remote: string): void {
  const reg = readRegistry(dataDir);
  if (reg === null || !(remote in reg.clients)) return;
  delete reg.clients[remote];
  fs.writeFileSync(registryPath(dataDir), JSON.stringify(reg, null, 2) + '\n', 'utf8');
}
