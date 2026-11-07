// practices 总览页：hub /u/ 个人页同构——二级 tab 行（总览/实践）+ [16rem_1fr] 栅格
// （左栏=用户名占位留空）。总览=最近 6 张实践卡双列网格+查看全部（GitHub Popular
// repositories 同构；贡献热力图无本地数据源不设）；实践=查找框+全量堆叠列表（hub
// MyInstances 同构，纯前端过滤）。数据窗 /api/practices 家目录现扫清单；卡点击直达
// wizard（head 的向导页），无修订的实例回落链页。tab 态走 ?tab=practices（hub 同款 URL）。
'use strict';

(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var all = [];      // /api/practices 全量（updated 降序，服务端已排）
  var query = '';    // 实践档查找词（纯前端过滤，hub MyInstances 同口径）
  var tab = 'overview';
  try {
    if (new URLSearchParams(location.search).get('tab') === 'practices') tab = 'practices';
  } catch (e) { /* 老浏览器：停在总览 */ }

  function target(p) {
    return p.head
      ? '/p/' + encodeURIComponent(p.name) + '/pop/' + encodeURIComponent(p.head.root)
      : '/p/' + encodeURIComponent(p.name) + '/';
  }

  // 实践卡（hub InstanceCard 解剖：标题 / 摘录 line-clamp-2 / meta 沉底；无头像与徽章）
  function card(p) {
    var excerpt = p.head ? esc(p.head.message) : '<span class="none">' + esc(POP_I18N.t('homeNoRevisions')) + '</span>';
    var date = p.updated ? esc(p.updated.slice(0, 10)) : '';
    return '<a class="card" href="' + target(p) + '">'
      + '<p class="card-title">' + esc(p.name) + '</p>'
      + '<p class="card-excerpt">' + excerpt + '</p>'
      + '<p class="card-meta">' + esc(POP_I18N.t('commitCount', p.commits)) + (date ? ' · ' + date : '') + '</p>'
      + '</a>';
  }

  // 空态图标=hub GitBranch（lucide v1.24 重设计版，与 hub 同形）
  var EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/></svg>';

  function emptyHtml() {
    return '<div class="empty">' + EMPTY_ICON
      + '<p class="lead">' + esc(POP_I18N.t('homeEmptyLead')) + '</p>'
      + '<p class="hint">' + POP_I18N.t('homeEmptyHint') + '</p></div>';
  }

  // ── 总览档：标题行（我的实践 + 截后计数 + 查看全部）+ 前 6 张双列网格（hub OverviewGrid）──
  function overviewHtml() {
    var list = all.slice(0, 6);
    if (!list.length) return emptyHtml();
    return '<div class="sec-head"><h2 class="sec-title">' + esc(POP_I18N.t('pageTitle'))
      + '<span class="sec-count">' + list.length + '</span></h2>'
      + '<button type="button" class="view-all" data-act="view-all">' + esc(POP_I18N.t('viewAll')) + '</button></div>'
      + '<div class="ov-grid">' + list.map(card).join('') + '</div>';
  }

  // ── 实践档：查找框工具行 + 全量堆叠列表（hub MyInstances；过滤命中 name/head message）──
  function filtered() {
    var q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(function (p) {
      return p.name.toLowerCase().indexOf(q) !== -1
        || (p.head && p.head.message ? p.head.message.toLowerCase().indexOf(q) !== -1 : false);
    });
  }

  function stackHtml(items) {
    return '<div class="stack-list">' + items.map(card).join('') + '</div>';
  }

  function practicesHtml() {
    if (!all.length) return emptyHtml();
    var html = '<div class="pr-toolbar"><div class="find-box">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.34-4.34"/></svg>'
      + '<input type="text" id="find-input" autocomplete="off" spellcheck="false" value="' + esc(query) + '" placeholder="' + esc(POP_I18N.t('findPlaceholder')) + '" aria-label="' + esc(POP_I18N.t('findPlaceholder')) + '">'
      + '</div></div>'
      + '<div id="plist">';
    var items = filtered();
    if (items.length === 0) {
      html += '<div class="find-empty">' + esc(POP_I18N.t('findPlaceholder')) + '：' + esc(query.trim()) + '</div>';
    } else {
      html += stackHtml(items);
    }
    return html + '</div>';
  }

  // ── tab 行文案与选中态（按钮骨架在 home.html，此处只填文案/徽标/高亮）──
  function renderTabs() {
    var ov = document.querySelector('[data-tab="overview"] [data-i18n]');
    var pr = document.querySelector('[data-tab="practices"] [data-i18n]');
    if (ov) ov.textContent = POP_I18N.t('tabOverview');
    if (pr) pr.textContent = POP_I18N.t('tabPractices');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
      var on = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('on', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    var count = document.getElementById('practice-count');
    if (count) {
      count.textContent = String(all.length);
      count.hidden = all.length === 0;
    }
  }

  function setTab(t) {
    tab = t;
    try {
      history.replaceState(null, '', t === 'practices' ? '?tab=practices' : location.pathname);
    } catch (e) { /* file: 等环境：只切视图不同步 URL */ }
    renderTabs();
    renderApp();
  }

  function renderApp() {
    var app = document.getElementById('app');
    app.innerHTML = '<div class="u-grid"><aside aria-hidden="true"></aside><div class="u-content">'
      + (tab === 'overview' ? overviewHtml() : practicesHtml())
      + '</div></div>';
    if (tab === 'overview') {
      var va = app.querySelector('[data-act="view-all"]');
      if (va) va.addEventListener('click', function () { setTab('practices'); });
    } else {
      var input = app.querySelector('#find-input');
      if (input) {
        input.addEventListener('input', function () {
          query = input.value;
          var items = filtered();
          var plist = app.querySelector('#plist');
          if (!plist) return;
          plist.innerHTML = items.length === 0
            ? '<div class="find-empty">' + esc(POP_I18N.t('findPlaceholder')) + '：' + esc(query.trim()) + '</div>'
            : stackHtml(items);
        });
      }
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () {
      var t = btn.getAttribute('data-tab');
      if (t && t !== tab) setTab(t);
    });
  });

  fetch('/api/practices')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      all = Array.isArray(list) ? list : [];
      renderTabs();
      renderApp();
    })
    .catch(function (e) {
      document.getElementById('app').innerHTML = '<div class="empty"><p class="lead">' + esc((e && e.message) || String(e)) + '</p></div>';
    });

  POP_I18N.onChange(function () {
    renderTabs();
    renderApp();
  });
})();
