// practices 总览页：/api/practices 家目录现扫清单，卡片点击直达 wizard（head 的向导页）；
// 无修订的实例回落链页。单仓模式不经过本页（cwd 命中实例时 web 直接起该实例）。
// 卡片形态对齐 hub InstanceCard（标题 + 摘录 + 页脚）。
'use strict';

(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function target(p) {
    return p.head
      ? '/p/' + encodeURIComponent(p.name) + '/pop/' + encodeURIComponent(p.head.root)
      : '/p/' + encodeURIComponent(p.name) + '/';
  }

  function card(p) {
    var excerpt = p.head ? esc(p.head.message) : '<span class="none">' + esc(POP_I18N.t('homeNoRevisions')) + '</span>';
    var time = p.updated ? esc(p.updated.slice(0, 10)) : '';
    return '<a class="card" href="' + target(p) + '">'
      + '<div class="card-title">' + esc(p.name) + '</div>'
      + '<div class="card-excerpt">' + excerpt + '</div>'
      + '<div class="card-foot"><span>' + esc(POP_I18N.t('commitCount', p.commits)) + '</span><span>' + time + '</span></div>'
      + '</a>';
  }

  var EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

  fetch('/api/practices')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var app = document.getElementById('app');
      if (!list.length) {
        app.innerHTML = '<div class="empty">' + EMPTY_ICON
          + '<p class="lead">' + esc(POP_I18N.t('homeEmptyLead')) + '</p>'
          + '<p class="hint">' + POP_I18N.t('homeEmptyHint') + '</p></div>';
        return;
      }
      app.innerHTML = '<h1 class="page-title">' + esc(POP_I18N.t('pageTitle')) + '</h1>'
        + '<div class="cards">' + list.map(card).join('') + '</div>';
    })
    .catch(function (e) {
      document.getElementById('app').innerHTML = '<div class="empty"><p class="lead">' + esc((e && e.message) || String(e)) + '</p></div>';
    });
})();
