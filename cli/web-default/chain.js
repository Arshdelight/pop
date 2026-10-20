// 实例浏览页：提交链（当前支 tip 在前）+ 支切换。数据窗 /api/repo，只读。
'use strict';

(function () {
  var params = new URLSearchParams(location.search);
  var wantedBranch = params.get('branch');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  fetch('/api/repo' + (wantedBranch ? '?branch=' + encodeURIComponent(wantedBranch) : ''))
    .then(function (r) { return r.json(); })
    .then(function (repo) {
      var app = document.getElementById('app');
      var head = '<div class="repo-head">'
        + '<span class="repo-name">' + esc(repo.name) + '</span>'
        + (repo.owner ? '<span class="repo-owner">' + esc(repo.owner) + '</span>' : '')
        + '</div>';
      var branches = '<div class="branches">' + repo.branches.map(function (b) {
        var label = esc(b.name) + (b.isDefault ? ' (default)' : '');
        return '<button class="branch-btn' + (b.current ? ' current' : '') + '" data-branch="' + esc(b.name) + '"'
          + (b.current ? ' disabled' : '') + '>' + label + '</button>';
      }).join('') + '</div>';

      var rows;
      if (!repo.commits || repo.commits.length === 0) {
        rows = '<div class="empty">no revisions yet — edit ' + esc(repo.name)
          + '.json and run <code>practi commit -m "..."</code></div>';
      } else {
        rows = '<ul class="commits">' + repo.commits.map(function (c) {
          return '<li class="commit">'
            + '<span class="seq">v' + c.seq + '</span>'
            + '<a class="root" href="/pop/' + encodeURIComponent(c.root) + '" title="' + esc(c.root) + '">' + esc(c.root.slice(7, 19)) + '</a>'
            + '<span class="msg">' + esc(c.message) + '</span>'
            + (c.pushedAt ? '' : '<span class="badge">local, unpushed</span>')
            + '</li>';
        }).join('') + '</ul>';
      }
      app.innerHTML = head + branches + rows;

      Array.prototype.forEach.call(app.querySelectorAll('.branch-btn'), function (btn) {
        btn.addEventListener('click', function () {
          var b = btn.getAttribute('data-branch');
          location.search = b && b !== 'main' ? '?branch=' + encodeURIComponent(b) : '';
        });
      });
    })
    .catch(function (e) {
      document.getElementById('app').innerHTML = '<div class="empty">failed to load: ' + esc(e && e.message) + '</div>';
    });
})();
