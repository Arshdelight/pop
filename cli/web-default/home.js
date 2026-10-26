// practices 总览页：/api/practices 家目录现扫清单，行点击直达 wizard（head 的向导页）；
// 无修订的实例回落链页。单仓模式不经过本页（cwd 命中实例时 web 直接起该实例）。
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

  function row(p) {
    var msg = p.head ? esc(p.head.message) : '<span class="none">' + esc(POP_I18N.t('homeNoRevisions')) + '</span>';
    var time = p.updated ? esc(p.updated.slice(0, 10)) : '';
    return '<tr>'
      + '<td class="name"><a href="' + target(p) + '">' + esc(p.name) + '</a></td>'
      + '<td class="msg">' + msg + '</td>'
      + '<td class="num">' + p.commits + '</td>'
      + '<td class="time">' + time + '</td>'
      + '</tr>';
  }

  fetch('/api/practices')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var app = document.getElementById('app');
      if (!list.length) {
        app.innerHTML = '<div class="empty"><p class="lead">' + esc(POP_I18N.t('homeEmptyLead')) + '</p>'
          + '<p class="hint">' + POP_I18N.t('homeEmptyHint') + '</p></div>';
        return;
      }
      app.innerHTML = '<h1 class="page-title">' + esc(POP_I18N.t('pageTitle')) + '</h1>'
        + '<table class="practices"><thead><tr>'
        + '<th>' + esc(POP_I18N.t('thPractice')) + '</th>'
        + '<th>' + esc(POP_I18N.t('homeHead')) + '</th>'
        + '<th class="num">' + esc(POP_I18N.t('thCommits')) + '</th>'
        + '<th class="time">' + esc(POP_I18N.t('homeUpdated')) + '</th>'
        + '</tr></thead><tbody>' + list.map(row).join('') + '</tbody></table>';
    })
    .catch(function (e) {
      document.getElementById('app').innerHTML = '<div class="empty">' + esc((e && e.message) || String(e)) + '</div>';
    });
})();
