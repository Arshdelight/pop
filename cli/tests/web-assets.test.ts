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

/** 样式表里某个选择器的规则体（按行首整条匹配；找不到即测试失败） */
function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = read('style.css').match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  if (!m) throw new Error(`style.css: rule "${selector}" not found`);
  return m[1]!;
}

describe('web-default：详情页版本条与步骤卡', () => {
  it('版本条挂在页眉之下；旧的内容列顶栏（返回 / 修订历史 / 信息）三处都已拆净', () => {
    expect(read('detail.html')).toContain('<div class="version-bar" id="version-bar" hidden></div>');
    expect(read('detail.js')).not.toMatch(/topbarHtml|detail-topbar|BACK_SVG/);
    expect(read('style.css')).not.toMatch(/detail-topbar|topbar-right/);
  });

  it('分支选择器 / 提交数 / 回到头版本 / 信息按钮都在版本条上，数据取自 /api/repo', () => {
    const js = read('detail.js');
    expect(js).toContain("fetch(P + '/api/repo')");
    for (const needle of ['data-act="branch-toggle"', 'data-act="branch-pick"', 'vb-commits', 'class="vb-link"', 'data-top="info"']) {
      expect(js).toContain(needle);
    }
    const css = read('style.css');
    for (const selector of ['.version-bar', '.branch-select', '.branch-menu', '.branch-option', '.vb-badge']) {
      expect(css).toContain(`${selector} {`);
    }
  });

  it('「注意」提醒框垫底：节点页的输入 / 清单 / 正文 / 子步骤都出完才轮到它', () => {
    const body = read('detail.js').slice(read('detail.js').indexOf('function nodeHtml(node)'), read('detail.js').indexOf('\n}\n', read('detail.js').indexOf('function nodeHtml(node)')));
    expect(body).toContain('html += noticeHtml(node);');
    const noticeAt = body.indexOf('html += noticeHtml(node);');
    for (const section of ["html += inputsHtml(node)", "flowsHtml(node, 'externalInputs'", 'html += proseHtml(node)', "html += outputsHtml(node)", 'html += childrenHtml(node)']) {
      expect(body.indexOf(section), section).toBeGreaterThan(-1);
      expect(noticeAt, section).toBeGreaterThan(body.indexOf(section));
    }
  });

  it('派生清单的条目：序号画进条目（悬停高亮连「数字＋点」一起包住），点击弹步骤菜单、菜单项直达步骤', () => {
    const js = read('detail.js');
    expect(js).not.toMatch(/openFlows|flow-refs/); // 行内开关式展开编号的旧实现已拆净
    // 序号与名字同在按钮里；菜单默认隐藏、挂在按钮之后
    expect(js).toContain("' + idx + body + '</button>' +");
    expect(js).toContain("class=\"flow-toggle\" data-flow-key=\"' + escapeHtml(key) + '\" aria-haspopup=\"menu\" aria-expanded=\"' + isOpen");
    expect(js).toContain("class=\"flow-option\" role=\"menuitem\" data-path=\"' + s.path + '\"");
    expect(js).toContain("'<div class=\"flow-menu\" role=\"menu\"' + (isOpen ? '' : ' hidden') + '>'");
    const css = read('style.css');
    expect(cssRule('ol.io-list.flow-list')).toContain('list-style: none');
    expect(cssRule('ol.io-list.flow-list')).toContain('padding-left: 0');
    expect(cssRule('.flow-menu')).toContain('position: absolute');
    expect(cssRule('.flow-menu.up')).toContain('bottom: 100%');
    expect(css).not.toContain('.flow-refs');
  });

  it('步骤卡与选项卡同观感（hub ChildCard 同款）：节点名正黑、圆角 10px、悬停品牌蓝描边、描述 80% 墨', () => {
    for (const card of ['.child-card', '.choice-card']) {
      expect(cssRule(card)).toContain('color: var(--ink)');
      expect(cssRule(card)).toContain('border-radius: 10px');
    }
    expect(cssRule('button.child-card:hover')).toContain('border-color: var(--secondary-brand)');
    expect(cssRule('.choice-card:hover')).toContain('border-color: var(--secondary-brand)');
    expect(cssRule('.child-desc')).toContain('color: var(--ink-a80)');
  });
});

describe('web-default：语言层', () => {
  it('lang.js：中英键集一致、同名键类型一致（缺键=界面冒出裸键名）', async () => {
    const { default: vm } = await import('node:vm');
    // 字典 M 不对外导出：在内存里的副本上改导出行取出来，落盘文件不动
    const EXPORT = 'return { t: t, getLang: getLang, setLang: setLang, onChange: onChange };';
    const src = read('lang.js');
    expect(src).toContain(EXPORT);
    const ctx = vm.createContext({
      document: { addEventListener() {}, documentElement: {} },
      localStorage: { getItem: () => null, setItem() {} },
    });
    vm.runInContext(src.replace(EXPORT, 'return { M: M };'), ctx);
    const M = vm.runInContext('POP_I18N.M', ctx) as Record<'zh' | 'en', Record<string, unknown>>;
    expect(Object.keys(M.en).sort()).toEqual(Object.keys(M.zh).sort());
    for (const key of Object.keys(M.zh)) expect(typeof M.en[key]).toBe(typeof M.zh[key]);
    // 版本条与步骤菜单用到的文案两种语言都齐
    for (const key of ['switchBranch', 'commitCount', 'createdAtOn', 'backToHead', 'syncNone', 'syncPartial', 'syncPushed', 'flowMenuTitle', 'flowToggleTip']) {
      expect(M.zh[key], key).toBeTruthy();
      expect(M.en[key], key).toBeTruthy();
    }
  });
});
