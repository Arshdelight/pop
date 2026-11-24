import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { browserOpenCommand } from '../src/web.js';

/**
 * openBrowser 的 Windows 分支：cmd 把 & 当命令分隔符，带 query 的 OAuth 授权 URL 必须整体加引号。
 * 2026-10-20 实例文件夹模型重构时丢了引号，`practi login` 打开的授权页被截断在首个 &，
 * hub 报「授权请求不完整」——这里卡住调用形状，并在真 Windows 上让 cmd 实际解析一遍。
 */
const URL_WITH_QUERY =
  'https://practihub.com/oauth/authorize?response_type=code&client_id=abc&state=s1&resource=https%3A%2F%2Fpractihub.com%2Fcli';

describe('browserOpenCommand（打开授权链接）', () => {
  it('win32：URL 整体加引号，start 的首个引号参数是窗口标题占位，verbatim 解析', () => {
    const r = browserOpenCommand('win32', URL_WITH_QUERY);
    expect(r.cmd).toBe('cmd');
    expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(r.args[3]).toBe(`start "" "${URL_WITH_QUERY}"`);
    expect(r.verbatim).toBe(true);
  });

  it('其它平台：直接把 URL 作为唯一参数', () => {
    expect(browserOpenCommand('darwin', URL_WITH_QUERY)).toEqual({ cmd: 'open', args: [URL_WITH_QUERY], verbatim: false });
    expect(browserOpenCommand('linux', URL_WITH_QUERY)).toEqual({ cmd: 'xdg-open', args: [URL_WITH_QUERY], verbatim: false });
  });

  it.skipIf(process.platform !== 'win32')('win32 实测：cmd 解析后 URL 逐字完整，& 没被当命令分隔符', () => {
    const { args, verbatim } = browserOpenCommand('win32', URL_WITH_QUERY);
    // 不真开浏览器：把 start "" 换成 echo，其余调用形状原样
    const echoArgs = [...args.slice(0, 3), args[3].replace('start ""', 'echo')];
    const r = spawnSync('cmd', echoArgs, { encoding: 'utf8', windowsVerbatimArguments: verbatim });
    expect(r.status).toBe(0);
    // echo 原样输出引号里的内容（含引号本身）；cmd 没在 & 处断开 = URL 逐字完整
    expect(r.stdout.trim()).toBe(`"${URL_WITH_QUERY}"`);
  });
});
