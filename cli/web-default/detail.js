// practi web 详情页（向导模式）：一次只显示一个节点，从根出发，Next 逐步走。
// op 决定呈现：seq=顺序列表预告；par=并行徽章+双列卡片；choice=可点选项卡（必须
// 择一才继续，选过的分支走完自动翻过整个 choice）；set=目录链接自由跳转；
// loop=循环徽章+条件旁注。数据走 /doc/<hash>.json（文档树，children 递归内联）。
'use strict';

var doc = null;
var path = [];    // 当前节点 = 从根出发的 children 下标路径；[] = 根
var navStack = []; // 走过的路径栈，Prev 回退用（避开只读全局 window.history）

var OP_META = {
  seq: { label: 'sequence', cls: 'b-seq', note: null },
  par: { label: 'parallel', cls: 'b-par', note: 'the steps below run in parallel — order does not matter' },
  choice: { label: 'choice', cls: 'b-choice', note: 'pick one branch to continue' },
  set: { label: 'catalog', cls: 'b-set', note: 'independent sections — jump freely, no ordering' },
  loop: { label: 'loop', cls: 'b-loop', note: null },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function walk(p) {
  var n = doc;
  for (var i = 0; i < p.length; i++) n = n.children[p[i]];
  return n;
}

function pathNum(p) {
  return p.length ? p.map(function (i) { return i + 1; }).join('.') : '·';
}

// 下一个节点：有孩子且非 choice → 首个孩子；否则向上找下一个兄弟。
// choice 的其他选项是「未选的分支」，不算下一步——选过的分支走完直接翻过整个 choice
function nextOf(p) {
  var node = walk(p);
  if (node.children && node.children.length && node.op !== 'choice') return p.concat([0]);
  var q = p.slice();
  while (q.length) {
    var idx = q.pop();
    var parent = walk(q);
    if (idx + 1 < parent.children.length && parent.op !== 'choice') return q.concat([idx + 1]);
  }
  return null; // 走完了
}

function goTo(p) {
  navStack.push(path.slice());
  path = p;
  render();
}

function shortHash(h) {
  return String(h).length > 16 ? String(h).slice(0, 16) + '…' : String(h);
}

// ── 渲染 ──────────────────────────────────────────────

function render() {
  var app = document.getElementById('app');
  var node = walk(path);
  // 机器视图链接留在流内（正文末尾），固定底栏只放 Prev/Next
  app.innerHTML = topHtml() + nodeHtml(node) +
    '<div class="machine-links"><a href="/pop/' + encodeURIComponent(HASH) + '.json">StandardView JSON</a> · ' +
    '<a href="/doc/' + encodeURIComponent(HASH) + '.json">document JSON</a></div>' + navHtml();
  window.scrollTo(0, 0);
}

// 顶部：图标返回钮 + 路径面包屑（只列当前以上的节点，当前名字只出现在大标题里，
// 根节点带文档图标锚定「在哪篇实践里」；在根时面包屑区留空）
var BACK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
var DOC_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

function topHtml() {
  var html = '<div class="detail-top">' +
    '<a class="back-btn" href="/" aria-label="back to directory" title="All practices">' + BACK_ICON + '</a>';
  if (path.length > 0) {
    html += '<div class="path-crumbs">' +
      '<a href="#" data-path="" class="crumb-root">' + DOC_ICON + '<span class="crumb-name">' + escapeHtml(doc.name) + '</span></a>';
    for (var i = 0; i < path.length - 1; i++) {
      var anc = walk(path.slice(0, i));
      html += '<span class="sep">›</span>' +
        '<a href="#" data-path="' + path.slice(0, i + 1).join(',') + '"><span class="crumb-name">' + escapeHtml(anc.children[path[i]].name) + '</span></a>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function nodeHtml(node) {
  var html = '<div class="node-head">';
  if (node.type === 'practice') {
    var meta = OP_META[node.op] || OP_META.seq;
    html += '<span class="badge ' + meta.cls + '">' + meta.label + '</span>';
  } else {
    html += '<span class="badge b-action">action</span>';
  }
  html += '<span class="node-num">#' + pathNum(path) + '</span></div>';
  html += '<h1 class="node-title">' + escapeHtml(node.name) + '</h1>';
  if (node.description) html += '<p class="node-desc">' + escapeHtml(node.description) + '</p>';

  if (node.type === 'practice') {
    var meta2 = OP_META[node.op] || OP_META.seq;
    var note = node.op === 'loop' ? loopNote(node) : meta2.note;
    if (note) html += '<p class="op-note">' + escapeHtml(note) + '</p>';
  }

  html += proseHtml(node);
  if (node.type === 'action') html += ioHtml(node) + attHtml(node);
  html += childrenHtml(node) + choiceHtml(node) + setHtml(node);
  html += revisionsHtml(node);
  return html;
}

function loopNote(node) {
  if (node.loop && node.loop.mode === 'count') return 'repeat ×' + node.loop.count;
  if (node.loop && node.loop.mode === 'until') return 'repeat until: ' + node.loop.until;
  return 'repeat';
}

// ── 正文（markdown-lite：围栏代码块 + 图片引用，其余按段落转义） ──

function proseHtml(node) {
  var content = node.content || '';
  if (!content.trim()) return '';
  var blocks = [];
  var prose = content.replace(/```[\s\S]*?```/g, function (m) {
    blocks.push(m);
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  var parts = [];
  var last = 0;
  var re = /!\[([^\]]*)\]\(([^)]*)\)/g;
  var m;
  while ((m = re.exec(prose)) !== null) {
    parts.push(paraHtml(prose.slice(last, m.index)));
    var url = mediaUrl(m[2], node);
    if (url === null) {
      parts.push('<p>' + escapeHtml(m[0]) + '</p>');
    } else {
      parts.push('<figure><img src="' + escapeHtml(url) + '" alt="' + escapeHtml(m[1]) + '">' +
        '<figcaption>' + escapeHtml(m[1]) + '</figcaption></figure>');
    }
    last = m.index + m[0].length;
  }
  parts.push(paraHtml(prose.slice(last)));
  var out = parts.join('');
  return '<div class="prose">' + out.replace(/\u0000B(\d+)\u0000/g, function (_, i) {
    return '<pre>' + escapeHtml(blocks[Number(i)]) + '</pre>';
  }) + '</div>';
}

function paraHtml(text) {
  var t = text.trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map(function (p) {
    return '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

// §5.1 media：http(s) 外链原样；按名命中附件 → url ?? /blobs/hash；未命中留原文
function mediaUrl(target, node) {
  if (/^https?:\/\//i.test(target)) return target;
  if (!node || node.type !== 'action' || !node.attachments) return null;
  for (var i = 0; i < node.attachments.length; i++) {
    if (node.attachments[i].name === target) {
      return node.attachments[i].url || ('/blobs/' + node.attachments[i].hash);
    }
  }
  return null;
}

// ── action 字段：输入/输出双栏 + 附件表 ──

function ioHtml(node) {
  var ins = node.inputs || [];
  var outs = node.outputs || [];
  if (!ins.length && !outs.length) return '';
  function item(f) {
    return '<li>' + escapeHtml(f.name) + (f.spec ? '（' + escapeHtml(f.spec) + '）' : '') +
      (f.from ? ' <span class="io-from">← ' + escapeHtml(shortHash(f.from)) + '</span>' : '') + '</li>';
  }
  return '<div class="io-grid">' +
    '<div class="io-col"><div class="label">inputs</div><ul>' + (ins.length ? ins.map(item).join('') : '<li class="none">none</li>') + '</ul></div>' +
    '<div class="io-col"><div class="label">outputs</div><ul>' + (outs.length ? outs.map(item).join('') : '<li class="none">none</li>') + '</ul></div>' +
    '</div>';
}

function attHtml(node) {
  var atts = node.attachments || [];
  if (!atts.length) return '';
  return '<div class="section-sm"><div class="label">attachments</div><ul class="att-list">' + atts.map(function (a) {
    var href = a.url || ('/blobs/' + a.hash);
    var meta = [a.mime, a.hash ? shortHash(a.hash) : ''].filter(Boolean).join(' · ');
    return '<li><a href="' + escapeHtml(href) + '">' + escapeHtml(a.name) + '</a>' +
      (meta ? ' <span class="att-meta">' + escapeHtml(meta) + '</span>' : '') + '</li>';
  }).join('') + '</ul></div>';
}

// ── practice 的孩子呈现（按 op 分形态） ──

function childrenHtml(node) {
  var kids = node.children || [];
  if (!kids.length || node.op === 'choice' || node.op === 'set') return '';
  var head = node.op === 'seq' ? '<div class="section-sm"><div class="label">steps (' + kids.length + ')</div></div>' : '';
  var items = kids.map(function (k, i) {
    return '<div class="child-card">' + (i + 1) + '. ' + escapeHtml(k.name) +
      (k.description ? '<div class="child-desc">' + escapeHtml(k.description) + '</div>' : '') + '</div>';
  }).join('');
  return head + (node.op === 'par' ? '<div class="child-grid">' + items + '</div>' : items);
}

function choiceHtml(node) {
  if (node.op !== 'choice') return '';
  return (node.children || []).map(function (k, i) {
    return '<button type="button" class="choice-card" data-idx="' + i + '">' +
      '<span class="choice-letter">' + String.fromCharCode(65 + i) + '</span>' +
      '<span class="choice-body">' + escapeHtml(k.name) +
      (k.description ? '<span class="child-desc">' + escapeHtml(k.description) + '</span>' : '') + '</span></button>';
  }).join('');
}

function setHtml(node) {
  if (node.op !== 'set') return '';
  return (node.children || []).map(function (k, i) {
    return '<button type="button" class="set-link" data-idx="' + i + '">› ' + escapeHtml(k.name) +
      (k.description ? ' <span class="child-desc">' + escapeHtml(k.description) + '</span>' : '') + '</button>';
  }).join('');
}

function revisionsHtml(node) {
  var revs = node.revisions || [];
  if (!revs.length) return '';
  return '<div class="section-sm"><div class="label">revisions</div><ul class="att-list">' +
    revs.map(function (r) {
      return '<li>' + escapeHtml(r.when) + ' — ' + escapeHtml(r.what) +
        (r.from ? ' <span class="att-meta">← ' + escapeHtml(shortHash(r.from)) + '</span>' : '') + '</li>';
    }).join('') + '</ul></div>';
}

// ── 导航 ──

// 底部导航：固定在视口底部（钉死位置，不随内容高度漂移），内容与正文列同宽对齐
function navHtml() {
  var node = walk(path);
  var next = nextOf(path);
  var choiceGate = node.type === 'practice' && node.op === 'choice';
  var html = '<div class="nav"><div class="nav-row">';
  html += navStack.length ? '<button type="button" class="btn" data-act="prev">← Prev</button>' : '<span></span>';
  if (choiceGate) {
    html += '<span class="nav-hint">choose a branch to continue</span>';
  } else if (next) {
    html += '<button type="button" class="btn btn-primary" data-act="next">Next →</button>';
  } else {
    html += '<span class="finish">end of practice</span>' +
      '<button type="button" class="btn" data-act="restart">Restart</button>' +
      '<a class="btn" href="/">All practices</a>';
  }
  html += '</div></div>';
  return html;
}

// ── 事件（委托：innerHTML 重渲染不需要重复绑监听） ──

document.addEventListener('click', function (e) {
  var jump = e.target.closest('[data-idx]');
  if (jump) {
    goTo(path.concat([Number(jump.getAttribute('data-idx'))]));
    return;
  }
  var crumb = e.target.closest('[data-path]');
  if (crumb) {
    e.preventDefault();
    var raw = crumb.getAttribute('data-path');
    goTo(raw ? raw.split(',').map(Number) : []);
    return;
  }
  var act = e.target.closest('[data-act]');
  if (!act) return;
  var a = act.getAttribute('data-act');
  if (a === 'next') {
    var n = nextOf(path);
    if (n) goTo(n);
  } else if (a === 'prev') {
    if (navStack.length) {
      path = navStack.pop();
      render();
    }
  } else if (a === 'restart') {
    goTo([]);
  }
});

// ── 启动 ──

var HASH = decodeURIComponent((location.pathname.split('/pop/')[1] || '').replace(/\.json$/, ''));

fetch('/doc/' + encodeURIComponent(HASH) + '.json')
  .then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(function (d) {
    doc = d;
    render();
  })
  .catch(function (err) {
    document.getElementById('app').innerHTML =
      '<div class="empty"><p class="lead">failed to load document (' + escapeHtml(String(err.message || err)) + ')</p>' +
      '<p class="hint"><a href="/">← My practices</a></p></div>';
  });
