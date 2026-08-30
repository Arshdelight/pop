import { readSpec } from '@arshdelight/pop-sdk';

export interface SpecOpts {
  dataDir?: string;
}

/**
 * practi spec：打印本 CLI 所实现协议的 pop-spec.md（SDK 包内分发，readSpec 直读）。
 * 无网络依赖；重定向即导出：practi spec > spec.md。
 */
export function runSpec(_opts: SpecOpts): number {
  console.log(readSpec());
  return 0;
}
