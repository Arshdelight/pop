import { createRequire } from 'node:module';
import { POP_SPEC_VERSION } from '@arshdelight/pop-sdk';

/**
 * 版本单一来源：CLI 版本运行时读 package.json（不硬编码，防漂移），
 * 协议版本来自 SDK 导出的 POP_SPEC_VERSION（spec 升版只改 SDK 一处）。
 * src/ 与 dist/ 同深（../package.json 均指向 cli/package.json）。
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const CLI_VERSION = pkg.version;
export { POP_SPEC_VERSION };
