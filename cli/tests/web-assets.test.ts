import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * practi web 静态资源的副本一致性（pop#3 教训：favicon 曾是三页各带一份手抄
 * data-URI，抄残了两份且残得互不相同）。favicon 现为单一文件 favicon.svg（与 hub
 * src/app/icon.svg 同一文件），三页只留一行引用；页眉 logo 仍是三页各一份内联
 * SVG——这里卡住「favicon ⇄ 三页页眉 logo 路径逐字相同」，改形不同步其余副本即红。
 */
const WEB_DIR = fileURLToPath(new URL('../web-default/', import.meta.url));
const PAGES = ['home.html', 'chain.html', 'detail.html'];
const ICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';

function read(name: string): string {
  return fs.readFileSync(path.join(WEB_DIR, name), 'utf8');
}

/** SVG 里全部 <path d="…"> 的路径数据，按出现顺序 */
function pathData(svg: string): string[] {
  return [...svg.matchAll(/<path\s+d="([^"]*)"/g)].map((m) => m[1]!);
}

/** 页眉站点图标（<svg class="logo">；页面里其余 SVG 是 tab 图标，不相干） */
function headerLogo(page: string): string {
  const m = read(page).match(/<svg class="logo"[\s\S]*?<\/svg>/);
  if (!m) throw new Error(`${page}: header logo not found`);
  return m[0];
}

describe('web-default：站点图标单一来源', () => {
  it('favicon.svg 是三圈线团 mark', () => {
    const favicon = read('favicon.svg');
    expect(favicon).toContain('viewBox="67.5 75 459 459"');
    expect(pathData(favicon)).toHaveLength(3);
  });

  it.each(PAGES)('%s：图标只引用 /favicon.svg，不留手抄副本', (page) => {
    expect(read(page).match(/<link\s+rel="icon"[^>]*>/g)).toEqual([ICON_LINK]);
  });

  it.each(PAGES)('%s：页眉 logo 路径与 favicon 逐字相同', (page) => {
    expect(pathData(headerLogo(page))).toEqual(pathData(read('favicon.svg')));
  });
});
