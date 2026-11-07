// 实例浏览页：提交链（当前支 tip 在前）+ 支切换，形态对齐 hub commits 页
// （分支选择器行 + divide-y 版本行列表）。数据窗 /api/repo，只读。
// 单仓模式挂在 / 下；home 模式挂 /p/<name>/ 下，服务器注入 window.POP_WEB_PREFIX 供拼 API 与链接。
'use strict';

(function () {
  var P = window.POP_WEB_PREFIX || '';
  var params = new URLSearchParams(location.search);
  var wantedBranch = params.get('branch');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderCrumbs(repo) {
    var el = document.getElementById('crumbs');
    if (!el) return;
    el.innerHTML = (repo.owner ? '<a class="crumb" href="' + P + '/">' + esc(repo.owner) + '</a><span class="crumb-sep">/</span>' : '')
      + '<span class="crumb current">' + esc(repo.name) + '</span>';
  }

  var EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

  fetch(P + '/api/repo' + (wantedBranch ? '?branch=' + encodeURIComponent(wantedBranch) : ''))
    .then(function (r) { return r.json(); })
    .then(function (repo) {
      var app = document.getElementById('app');
      document.title = repo.name + ' — practi';
      renderCrumbs(repo);

      var bar = '<div class="branch-bar">' + repo.branches.map(function (b) {
        return '<button class="branch-btn' + (b.current ? ' current' : '') + '" data-branch="' + esc(b.name) + '"'
          + (b.current ? ' disabled' : '') + '>' + esc(b.name)
          + (b.isDefault ? '<span class="branch-default">' + esc(POP_I18N.t('defaultBranch')) + '</span>' : '')
          + '</button>';
      }).join('')
        + '<span class="rev-count">' + esc(POP_I18N.t('commitCount', repo.commits.length)) + '</span></div>';

      var rows;
      if (!repo.commits || repo.commits.length === 0) {
        rows = '<div class="empty">' + EMPTY_ICON
          + '<p class="lead">' + esc(POP_I18N.t('chainEmptyLead')) + '</p>'
          + '<p class="hint">' + POP_I18N.t('chainEmptyHint', esc(repo.name)) + '</p></div>';
      } else {
        rows = '<div class="commit-list">' + repo.commits.map(function (c) {
          return '<div class="commit">'
            + '<span class="rev-seq">v' + c.seq + '</span>'
            + '<span class="msg">' + esc(c.message) + '</span>'
            + (c.pushedAt ? '' : '<span class="badge-pill badge-warn">' + esc(POP_I18N.t('unpushed')) + '</span>')
            + '<span class="hash-link" title="' + esc(c.root) + '">' + esc(c.root.slice(7, 19)) + '</span>'
            + '<a class="browse" href="' + P + '/pop/' + encodeURIComponent(c.root) + '">' + esc(POP_I18N.t('browse')) + '</a>'
            + '</div>';
        }).join('') + '</div>';
      }
      app.innerHTML = bar + rows;

      Array.prototype.forEach.call(app.querySelectorAll('.branch-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var b = btn.getAttribute('data-branch');
          location.search = b && b !== 'main' ? '?branch=' + encodeURIComponent(b) : '';
        });
      });
    })
    .catch(function (e) {
      document.getElementById('app').innerHTML = '<div class="empty"><p class="lead">'
        + esc(POP_I18N.t('loadFail', (e && e.message) || String(e))) + '</p></div>';
    });
})();
