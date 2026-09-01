// practi web 默认前端逻辑：拉 /api/directs 渲染目录表格（客户端分页，每页 20 条）。
// 数据与展示分离：本文件只消费 JSON 数据窗，改样式改结构都在文件里随便改，
// 保存即触发 live reload（服务端注入的 /_lr.js 负责自动刷新）。
'use strict';

var PAGE_SIZE = 20;
var docs = [];
var page = 1;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 空态书本图标（lucide book-open，同 hub /me 空态）
var BOOK_ICON =
  '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 7v14"/>' +
  '<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>' +
  '</svg>';

function plural(n, unit) {
  return n + ' ' + unit + (n === 1 ? '' : 's');
}

// 本地时刻、精确到分钟：YYYY-MM-DD HH:mm（等宽数字，列内不截断）
function fmtDateTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Added 单元格：claimedAt=声明值（认领盖戳）；无 claimedAt 而 addedAt 存在=文件 mtime
// 推测值（弱化 + 悬浮说明）；两者皆无=空白
function addedCell(d) {
  if (!d.addedAt) return '<td class="doc-date"></td>';
  if (!d.claimedAt) {
    return '<td class="doc-date derived" title="file time (unstamped claim)">' + escapeHtml(fmtDateTime(d.addedAt)) + '</td>';
  }
  return '<td class="doc-date">' + escapeHtml(fmtDateTime(d.addedAt)) + '</td>';
}

function render() {
  var t = POP_I18N.t;
  var app = document.getElementById('app');
  if (docs.length === 0) {
    app.innerHTML =
      '<div class="empty">' + BOOK_ICON +
      '<p class="lead">' + t('emptyLead') + '</p>' +
      '<p class="hint">' + t('emptyHint') + '</p></div>';
    return;
  }
  var totalPages = Math.max(1, Math.ceil(docs.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  var rows = docs
    .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    .map(function (d) {
      return '<tr>' +
        '<td><a class="doc-name" href="/pop/' + encodeURIComponent(d.hash) + '">' + escapeHtml(d.name) + '</a>' +
        (d.description ? '<p class="doc-desc">' + escapeHtml(d.description) + '</p>' : '') + '</td>' +
        '<td class="doc-nodes">' + d.nodes + '</td>' +
        addedCell(d) +
        '</tr>';
    })
    .join('\n');
  var pager = '';
  if (page > 1 || page < totalPages) {
    pager = '<div class="pager">' +
      (page > 1 ? '<button type="button" data-page="' + (page - 1) + '">' + t('pagerPrev') + '</button>' : '') +
      (page < totalPages ? '<button type="button" data-page="' + (page + 1) + '">' + t('pagerNext') + '</button>' : '') +
      '</div>';
  }
  app.innerHTML =
    '<h3 class="page-title">' + t('pageTitle') + '</h3>' +
    '<table class="doc-table">' +
    '<thead><tr><th>' + t('thDocument') + '</th><th class="col-nodes">' + t('thNodes') + '</th><th class="col-added">' + t('thAdded') + '</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div class="count-row"><span>' + t('countDocs', docs.length) + ' · ' + t('pageOf', page, totalPages) + '</span>' + pager + '</div>';
}

// 翻页走事件委托：innerHTML 重渲染不需要重复绑监听
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-page]');
  if (!btn) return;
  page = Number(btn.getAttribute('data-page'));
  render();
});

// 语言切换：整页文案重渲染
POP_I18N.onChange(render);

fetch('/api/directs')
  .then(function (r) { return r.json(); })
  .then(function (data) {
    // 按 added 倒序：后发的在前；无 addedAt（时间未知）垫底
    docs = (data.docs || []).slice().sort(function (a, b) {
      return new Date(b.addedAt || 0) - new Date(a.addedAt || 0);
    });
    render();
  })
  .catch(function () {
    document.getElementById('app').innerHTML =
      '<div class="empty"><p class="lead">' + POP_I18N.t('loadFail') + '</p></div>';
  });
