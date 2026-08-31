// practi web 详情页（向导模式）：一次只显示一个节点，从根出发，Next 逐步走。
// op 决定呈现：seq=顺序列表预告（可点直达）；par=双列网格卡片；choice=可点选项卡（必须
// 择一才继续，选过的分支走完自动翻过整个 choice）；set=目录链接自由跳转；
// loop=条件旁注。数据走 /doc/<hash>.json（文档树，children 递归内联）。
'use strict';

var doc = null;
var path = [];    // 当前节点 = 从根出发的 children 下标路径；[] = 根
var navStack = []; // 走过的路径栈，Prev 回退用（避开只读全局 window.history）
var nodeIndex = null; // 哈希→树内路径登记簿（数据窗 nodeIndex），inputs.from 反解用

// op 旁注：用自然语言说清组合语义（seq 不需要说明）；loop 的旁注由 loopNote 按数据推导
var OP_NOTES = {
  par: 'the tasks below run in parallel — order does not matter',
  choice: 'pick one branch to continue',
  set: 'independent sections — jump freely, no ordering',
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
  app.innerHTML = topHtml() + nodeHtml(node) + navHtml();
  markSide();
  window.scrollTo(0, 0);
}

// ── 左侧大纲（学 hub /pop 详情侧栏）：根的直接孩子成节（1、2…）递归（1.1），
// 与 fromRef 的 #编号同一坐标系；点击 goTo 跳转，当前节点高亮 ──

function countActions(n) {
  if (n.type === 'action') return 1;
  return (n.children || []).reduce(function (s, c) { return s + countActions(c); }, 0);
}

function sideHtml() {
  var total = countActions(doc);
  // root 不占编号（与 fromRef 坐标系一致：引用编号从根的孩子起算），作为大纲锚头置顶
  var html = '<p class="side-count">' + total + (total === 1 ? ' step' : ' steps') + '</p>' +
    '<a href="#" class="side-item side-root" data-path="">' + escapeHtml(doc.name) + '</a>';
  (function walkSide(n, prefix, depth, p) {
    (n.children || []).forEach(function (c, i) {
      var num = prefix + (i + 1);
      var cp = p.concat([i]);
      html += '<a href="#" class="side-item" data-path="' + cp.join(',') + '" style="padding-left:' + (14 + depth * 14) + 'px">' +
        '<span class="side-num">' + num + '</span>' + escapeHtml(c.name) + '</a>';
      if (c.children && c.children.length) walkSide(c, num + '.', depth + 1, cp);
    });
  })(doc, '', 0, []);

  // 底部附加区：全文档 revisions（新→旧，点击跳到所属节点）+ refines 边
  // （目标在文档内 → #编号跳转；悬空 → 短哈希）；两段空则整段不出现。
  // 包在 .side-foot（margin-top:auto）里钉在侧栏最底，不贴着大纲
  var foot = '';
  var revs = [];
  var refs = [];
  (function w(n, p) {
    (n.revisions || []).forEach(function (r) { revs.push({ p: p, name: n.name, r: r }); });
    if (n.type === 'practice' && n.refines) refs.push({ p: p, name: n.name, target: n.refines });
    (n.children || []).forEach(function (c, i) { w(c, p.concat([i])); });
  })(doc, []);
  if (revs.length) {
    revs.sort(function (a, b) { return a.r.when < b.r.when ? 1 : -1; });
    foot += '<div class="side-sec"><p class="side-count">revisions (' + revs.length + ')</p>' +
      revs.map(function (v) {
        return '<a href="#" class="side-note" data-path="' + v.p.join(',') + '" data-tip="' + escapeHtml(v.name) + '">' +
          escapeHtml(String(v.r.when).slice(0, 10)) + ' — ' + escapeHtml(v.r.what) + '</a>';
      }).join('') + '</div>';
  }
  if (refs.length) {
    foot += '<div class="side-sec"><p class="side-count">refines (' + refs.length + ')</p>' +
      refs.map(function (v) {
        var tp = nodeIndex && nodeIndex[v.target];
        var tail = tp
          ? '<a href="#" class="side-note mono" data-path="' + tp.join(',') + '">→ #' + tp.map(function (i) { return i + 1; }).join('.') + '</a>'
          : '<span class="side-note mono plain">→ ' + escapeHtml(shortHash(v.target)) + '</span>';
        return '<div class="side-note-row"><span class="side-note plain" data-tip="' + escapeHtml(v.name) + '">' +
          escapeHtml(v.name) + '</span>' + tail + '</div>';
      }).join('') + '</div>';
  }
  // 机器视图出口常驻侧栏最底（档案区空时它独占底仓），两行各一条
  foot += '<div class="side-machine">' +
    '<a href="/pop/' + encodeURIComponent(HASH) + '.json">StandardView JSON</a>' +
    '<a href="/doc/' + encodeURIComponent(HASH) + '.json">document JSON</a></div>';
  return html + '<div class="side-foot">' + foot + '</div>';
}

function markSide() {
  var cur = path.join(',');
  var items = document.querySelectorAll('.side-item');
  for (var i = 0; i < items.length; i++) {
    // root 条目不参与 selected——点击前后观感一致，hover 仍可用
    if (items[i].classList.contains('side-root')) continue;
    items[i].classList.toggle('on', items[i].getAttribute('data-path') === cur);
  }
}

// 顶部：图标返回钮。原路径面包屑已删——「在哪」的职责交给左侧大纲（编号+高亮）
var BACK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

function topHtml() {
  return '<div class="detail-top">' +
    '<a class="back-btn" href="/" aria-label="back to directory" title="All practices">' + BACK_ICON + '</a></div>';
}

function nodeHtml(node) {
  var html = '<h1 class="node-title">' + escapeHtml(node.name) + '</h1>';
  if (node.description) html += '<p class="node-desc">' + escapeHtml(node.description) + '</p>';

  if (node.type === 'practice') {
    // loop 的 repeat 条件已升为循环体小节头，不再另发旁注
    var note = OP_NOTES[node.op];
    if (note) html += '<p class="op-note">' + escapeHtml(note) + '</p>';
  }

  if (node.type === 'action') html += inputsHtml(node);
  html += proseHtml(node);
  if (node.type === 'action') html += outputsHtml(node) + attHtml(node);
  html += childrenHtml(node) + choiceHtml(node) + setHtml(node);
  // revisions 已挪到左侧大纲底部（全文档汇总）；refines 同处
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
  return '<div class="section-sm"><div class="label">content</div><div class="prose">' +
    out.replace(/\u0000B(\d+)\u0000/g, function (_, i) {
      return '<pre>' + escapeHtml(blocks[Number(i)]) + '</pre>';
    }) + '</div></div>';
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

// ── action 字段：管道读序 inputs → 正文 → outputs，有序列表；空缺的块整个不出现 ──

// from 反解（同 hub 口径）：命中登记簿 → #编号引用（可点跳转 data-path 委托、
// 悬停气泡 data-tip=来源节点名）；未命中/无登记簿/指向根 → 短哈希（可验真）
function fromRef(from) {
  if (!from) return '';
  var p = nodeIndex && nodeIndex[from];
  if (!p) return ' <span class="io-from">← ' + escapeHtml(shortHash(from)) + '</span>';
  var num = p.map(function (i) { return i + 1; }).join('.');
  return ' <a href="#" class="io-ref" data-path="' + p.join(',') + '" data-tip="' + escapeHtml(walk(p).name) + '">← #' + num + '</a>';
}

function ioItem(f) {
  return '<li>' + escapeHtml(f.name) + (f.spec ? '（' + escapeHtml(f.spec) + '）' : '') + fromRef(f.from) + '</li>';
}

function inputsHtml(node) {
  var ins = node.inputs || [];
  if (!ins.length) return '';
  return '<div class="section-sm"><div class="label">inputs</div><ol class="io-list">' + ins.map(ioItem).join('') + '</ol></div>';
}

function outputsHtml(node) {
  var outs = node.outputs || [];
  if (!outs.length) return '';
  return '<div class="section-sm"><div class="label">outputs</div><ol class="io-list">' + outs.map(ioItem).join('') + '</ol></div>';
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
  // 小节头：seq=steps(N)、par=tasks(N)、loop=repeat 条件本身当头（旁注不再重复）
  var head = node.op === 'loop'
    ? '<div class="section-sm"><div class="label">' + escapeHtml(loopNote(node)) + '</div></div>'
    : '<div class="section-sm"><div class="label">' + (node.op === 'seq' ? 'steps' : 'tasks') + ' (' + kids.length + ')</div></div>';
  var items = kids.map(function (k, i) {
    var body = (i + 1) + '. ' + escapeHtml(k.name) +
      (k.description ? '<div class="child-desc">' + escapeHtml(k.description) + '</div>' : '');
    // 序号卡一律=预告+跳转入口（seq/par/loop 全可点直达）
    return '<button type="button" class="child-card" data-idx="' + i + '">' + body + '</button>';
  }).join('');
  return head + items;
}

function choiceHtml(node) {
  if (node.op !== 'choice') return '';
  var kids = node.children || [];
  return '<div class="section-sm"><div class="label">options (' + kids.length + ')</div></div>' +
    kids.map(function (k, i) {
      return '<button type="button" class="choice-card" data-idx="' + i + '">' +
        '<span class="choice-body">' + escapeHtml(k.name) +
        (k.description ? '<span class="child-desc">' + escapeHtml(k.description) + '</span>' : '') + '</span></button>';
    }).join('');
}

function setHtml(node) {
  if (node.op !== 'set') return '';
  var kids = node.children || [];
  return '<div class="section-sm"><div class="label">items (' + kids.length + ')</div></div>' +
    kids.map(function (k, i) {
      var body = (i + 1) + '. ' + escapeHtml(k.name) +
        (k.description ? '<div class="child-desc">' + escapeHtml(k.description) + '</div>' : '');
      return '<button type="button" class="child-card" data-idx="' + i + '">' + body + '</button>';
    }).join('');
}

// ── 导航 ──

// 底部操作区：固定在视口底（悬浮于内容列上方，宽屏 left 让出侧栏），无分界线
function navHtml() {
  var node = walk(path);
  var next = nextOf(path);
  var choiceGate = node.type === 'practice' && node.op === 'choice';
  var html = '<div class="nav"><div class="nav-row">';
  html += navStack.length ? '<button type="button" class="btn" data-act="prev">Prev</button>' : '<span></span>';
  if (choiceGate) {
    html += '<span class="nav-hint">choose a branch to continue</span>';
  } else if (next) {
    html += '<button type="button" class="btn btn-primary" data-act="next">Next</button>';
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
  var jump = e.target.closest('[data-path]');
  if (jump) {
    e.preventDefault();
    var raw = jump.getAttribute('data-path');
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
    // 数据窗=加法演进：树字段在顶层，nodeIndex 是后加的兄弟键（老响应没有它 → 哈希兜底）
    doc = d;
    nodeIndex = d.nodeIndex || null;
    document.getElementById('side').innerHTML = sideHtml();
    render();
  })
  .catch(function (err) {
    document.getElementById('app').innerHTML =
      '<div class="empty"><p class="lead">failed to load document (' + escapeHtml(String(err.message || err)) + ')</p>' +
      '<p class="hint"><a href="/">← My practices</a></p></div>';
  });
