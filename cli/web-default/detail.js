// practi web 详情页（向导模式）：一次只显示一个节点，从根出发，Next 逐步走。
// op 决定呈现：seq=顺序列表预告（可点直达）；par=双列网格卡片；choice=可点选项卡（必须
// 择一才继续，选过的分支走完自动翻过整个 choice）；set=目录链接自由跳转；
// loop=条件旁注。数据走 /doc/<hash>.json（文档树，children 递归内联）。
'use strict';

var doc = null;
var path = [];    // 当前节点 = 从根出发的 children 下标路径；[] = 根
var navStack = []; // 走过的路径栈，Prev 回退用（避开只读全局 window.history）
var nodeIndex = null; // 哈希→树内路径登记簿（数据窗 nodeIndex），inputs.from 反解用
var view = 'wizard';  // 内容区视图：wizard | sv | doc（侧栏顶部三 tab）
var svJson = null;    // StandardView JSON 缓存（首次切到该 tab 才拉取）

// op 旁注：用自然语言说清组合语义（seq 不需要说明）；loop 的旁注由 loopNote 按数据推导
var OP_NOTES = {
  par: function () { return POP_I18N.t('opPar'); },
  choice: function () { return POP_I18N.t('opChoice'); },
  set: function () { return POP_I18N.t('opSet'); },
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
  // 三视图：向导正文 / StandardView JSON / document JSON——侧栏大纲始终是导航脊柱，
  // 底部 Prev/Next 也常驻（在 JSON 视图里换节点=高亮跟着走）
  app.innerHTML = (view === 'wizard' ? nodeHtml(node) : jsonSectionHtml()) + navHtml();
  updateTabs();
  markSide();
  // 向导视图回顶（瞬移，既有行为）；JSON 视图平滑滚到当前高亮块首行。
  // 原生 smooth 滚动天然可中断：快速连点不同节点时，新目标的滚动指令
  // 会取消进行中的动画，从当前位置转向新目标（CSSOM View 语义）
  if (view === 'wizard') {
    window.scrollTo(0, 0);
  } else {
    var hl = document.querySelector('.json-pre .ln.hl');
    if (hl) hl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ── JSON 视图：pretty 渲染 + 当前节点高亮 ──
// document 视图：树即嵌套对象，当前节点 = walk(path) 的对象引用，按引用相等高亮（双胞胎只亮所在那份）
// StandardView 视图：practice 容器不进 steps，按「子树 steps 区段」高亮（steps 顺序与树遍历一致）；
// set 孩子的后代不递归聚合、天生不在视图里——老实不高亮

function jsonSectionHtml() {
  if (view === 'doc') {
    return '<div class="section-sm"><div class="label">' + POP_I18N.t('labelDocJson') + '</div>' +
      '<pre class="json-pre">' + jsonHtml(doc, markDoc) + '</pre></div>';
  }
  if (svJson === null) {
    return '<div class="section-sm"><div class="label">' + POP_I18N.t('labelSvJson') + '</div><p class="op-note">' + POP_I18N.t('loading') + '</p></div>';
  }
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('labelSvJson') + '</div>' +
    '<pre class="json-pre">' + jsonHtml(svJson, markSv) + '</pre></div>';
}

/** 按对象引用高亮：document 视图的目标就是当前节点对象本身 */
function markDoc(container, key, index, child) {
  return child === walk(path);
}

/** StandardView 高亮：复算 steps 遍历顺序（action/set 直接孩子=一步；其余 practice 递归），
 *  当前节点的子树 steps（含自身）全部高亮 */
function markSv(container, key, index, child) {
  if (!svJson || container !== svJson.steps) return false;
  var hits = svMarkedSteps();
  for (var i = 0; i < hits.length; i++) if (svJson.steps[hits[i]] === child) return true;
  return false;
}

function svMarkedSteps() {
  // 根节点不高亮（与 document 视图对齐）：全树都亮等于没有定位
  if (!path.length) return [];
  var marks = [];
  var idx = 0;
  (function w(n, p, parentIsSet) {
    (n.children || []).forEach(function (c, i) {
      var cp = p.concat([i]);
      // 聚合口径：action 叶子成一步；set 的直接孩子无论类型都成条目；其余 practice 递归
      var isStep = parentIsSet || c.type === 'action';
      if (isStep) {
        // 当前路径是该 step 路径的前缀（含相等）= 此 step 落在当前节点子树内
        if (cp.length >= path.length && path.every(function (v, k) { return cp[k] === v; })) marks.push(idx);
        idx++;
        return;
      }
      w(c, cp, c.op === 'set');
    });
  })(doc, [], false);
  return marks;
}

/** JSON → HTML：标准 pretty（2 空格缩进），markChild(container,key,index,child) 决定该孩子起是否高亮。
 *  行级输出：每行一个 span.ln（display:block），命中子树（hl 继承给后代）的开行、内部行、
 *  闭括号行各自整行铺底——编辑器选中行形态，不再按文本片段断续着色 */
function jsonHtml(value, markChild) {
  function esc(s) { return escapeHtml(s); }
  function w(v, depth, hl, key) {
    var pad = new Array(depth + 1).join('  ');
    var k = key === null ? '' : '<span class="jk">' + esc(JSON.stringify(key)) + '</span>: ';
    if (v === null) return [{ t: pad + k + 'null', h: hl }];
    if (Array.isArray(v)) {
      if (!v.length) return [{ t: pad + k + '[]', h: hl }];
      var lines = [{ t: pad + k + '[', h: hl }];
      v.forEach(function (x, i) {
        var block = w(x, depth + 1, hl || markChild(v, null, i, x), null);
        if (i < v.length - 1) block[block.length - 1].t += ',';
        lines = lines.concat(block);
      });
      lines.push({ t: pad + ']', h: hl });
      return lines;
    }
    if (typeof v === 'object') {
      var keys = Object.keys(v);
      if (!keys.length) return [{ t: pad + k + '{}', h: hl }];
      var lines2 = [{ t: pad + k + '{', h: hl }];
      keys.forEach(function (kk, i) {
        var block2 = w(v[kk], depth + 1, hl || markChild(v, kk, null, v[kk]), kk);
        if (i < keys.length - 1) block2[block2.length - 1].t += ',';
        lines2 = lines2.concat(block2);
      });
      lines2.push({ t: pad + '}', h: hl });
      return lines2;
    }
    return [{ t: pad + k + (typeof v === 'string' ? esc(JSON.stringify(v)) : String(v)), h: hl }];
  }
  return w(value, 0, false, null).map(function (l) {
    return '<span class="ln' + (l.h ? ' hl' : '') + '">' + l.t + '</span>';
  }).join('');
}

// ── 左侧大纲（学 hub /pop 详情侧栏）：根的直接孩子成节（1、2…）递归（1.1），
// 与 fromRef 的 #编号同一坐标系；点击 goTo 跳转，当前节点高亮 ──

function countActions(n) {
  if (n.type === 'action') return 1;
  return (n.children || []).reduce(function (s, c) { return s + countActions(c); }, 0);
}

function sideHtml() {
  var total = countActions(doc);
  // 视图三 tab 钉在侧栏最顶：向导正文 / StandardView JSON / document JSON（内容区随之换形态）
  var html = '<div class="side-tabs">' +
    '<button type="button" class="side-tab" data-view="wizard">' + POP_I18N.t('tabWizard') + '</button>' +
    '<button type="button" class="side-tab" data-view="sv">' + POP_I18N.t('tabSv') + '</button>' +
    '<button type="button" class="side-tab" data-view="doc">' + POP_I18N.t('tabDoc') + '</button>' +
    '</div>' +
    '<p class="side-count">' + POP_I18N.t('stepCount', total) + '</p>' +
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
    foot += '<div class="side-sec"><p class="side-count">' + POP_I18N.t('revisions', revs.length) + '</p>' +
      revs.map(function (v) {
        return '<a href="#" class="side-note" data-path="' + v.p.join(',') + '" data-tip="' + escapeHtml(v.name) + '">' +
          escapeHtml(String(v.r.when).slice(0, 10)) + ' — ' + escapeHtml(v.r.what) + '</a>';
      }).join('') + '</div>';
  }
  if (refs.length) {
    foot += '<div class="side-sec"><p class="side-count">' + POP_I18N.t('refines', refs.length) + '</p>' +
      refs.map(function (v) {
        var tp = nodeIndex && nodeIndex[v.target];
        var tail = tp
          ? '<a href="#" class="side-note mono" data-path="' + tp.join(',') + '">→ #' + tp.map(function (i) { return i + 1; }).join('.') + '</a>'
          : '<span class="side-note mono plain">→ ' + escapeHtml(shortHash(v.target)) + '</span>';
        return '<div class="side-note-row"><span class="side-note plain" data-tip="' + escapeHtml(v.name) + '">' +
          escapeHtml(v.name) + '</span>' + tail + '</div>';
      }).join('') + '</div>';
  }
  return html + (foot ? '<div class="side-foot">' + foot + '</div>' : '');
}

function updateTabs() {
  var tabs = document.querySelectorAll('.side-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('on', tabs[i].getAttribute('data-view') === view);
  }
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

// 顶部区已撤：返回职责归 header 左上角 brand-link（回目录），定位职责归左侧大纲

function nodeHtml(node) {
  var html = '<h1 class="node-title">' + escapeHtml(node.name) + '</h1>';
  if (node.description) html += '<p class="node-desc">' + escapeHtml(node.description) + '</p>';

  if (node.type === 'practice') {
    // loop 的 repeat 条件已升为循环体小节头，不再另发旁注
    var note = OP_NOTES[node.op];
    if (note) html += '<p class="op-note">' + escapeHtml(note()) + '</p>';
  }

  if (node.type === 'action') html += inputsHtml(node);
  html += proseHtml(node);
  if (node.type === 'action') html += outputsHtml(node) + attHtml(node);
  html += childrenHtml(node) + choiceHtml(node) + setHtml(node);
  // revisions 已挪到左侧大纲底部（全文档汇总）；refines 同处
  return html;
}

function loopNote(node) {
  if (node.loop && node.loop.mode === 'count') return POP_I18N.t('repeatX', node.loop.count);
  if (node.loop && node.loop.mode === 'until') return POP_I18N.t('repeatUntil', node.loop.until);
  return POP_I18N.t('repeat');
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
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secContent') + '</div><div class="prose">' +
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
  return '<li>' + escapeHtml(f.name) + fromRef(f.from) +
    (f.spec ? '<span class="io-spec">' + escapeHtml(f.spec) + '</span>' : '') + '</li>';
}

function inputsHtml(node) {
  var ins = node.inputs || [];
  if (!ins.length) return '';
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secInputs') + '</div><ol class="io-list">' + ins.map(ioItem).join('') + '</ol></div>';
}

function outputsHtml(node) {
  var outs = node.outputs || [];
  if (!outs.length) return '';
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secOutputs') + '</div><ol class="io-list">' + outs.map(ioItem).join('') + '</ol></div>';
}

function attHtml(node) {
  var atts = node.attachments || [];
  if (!atts.length) return '';
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secAttachments') + '</div><ul class="att-list">' + atts.map(function (a) {
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
    : '<div class="section-sm"><div class="label">' + POP_I18N.t(node.op === 'seq' ? 'secSteps' : 'secTasks', kids.length) + '</div></div>';
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
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secOptions', kids.length) + '</div></div>' +
    kids.map(function (k, i) {
      return '<button type="button" class="choice-card" data-idx="' + i + '">' +
        '<span class="choice-body">' + escapeHtml(k.name) +
        (k.description ? '<span class="child-desc">' + escapeHtml(k.description) + '</span>' : '') + '</span></button>';
    }).join('');
}

function setHtml(node) {
  if (node.op !== 'set') return '';
  var kids = node.children || [];
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secItems', kids.length) + '</div></div>' +
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
  html += navStack.length ? '<button type="button" class="btn" data-act="prev">' + POP_I18N.t('wizardPrev') + '</button>' : '<span></span>';
  if (choiceGate) {
    html += '<span class="nav-hint">' + POP_I18N.t('chooseBranch') + '</span>';
  } else if (next) {
    html += '<button type="button" class="btn btn-primary" data-act="next">' + POP_I18N.t('next') + '</button>';
  } else {
    html += '<span class="finish">' + POP_I18N.t('endPractice') + '</span>';
  }
  html += '</div></div>';
  return html;
}

// ── 事件（委托：innerHTML 重渲染不需要重复绑监听） ──

document.addEventListener('click', function (e) {
  var tab = e.target.closest('[data-view]');
  if (tab) {
    view = tab.getAttribute('data-view');
    if (view === 'sv' && svJson === null) {
      // StandardView 首切拉取一次即缓存；期间先渲染 loading，到了再重绘
      fetch('/pop/' + encodeURIComponent(HASH) + '.json')
        .then(function (r) { return r.json(); })
        .then(function (j) { svJson = j; if (view === 'sv') render(); });
    }
    render();
    return;
  }
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
  }
});

// ── 启动 ──

// 语言切换：侧栏大纲与内容区一并重绘
POP_I18N.onChange(function () {
  if (doc) document.getElementById('side').innerHTML = sideHtml();
  render();
});

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
    document.title = doc.name + ' — practi';
    document.getElementById('side').innerHTML = sideHtml();
    render();
  })
  .catch(function (err) {
    document.getElementById('app').innerHTML =
      '<div class="empty"><p class="lead">' + POP_I18N.t('docFail', escapeHtml(String(err.message || err))) + '</p>' +
      '<p class="hint"><a href="/">' + POP_I18N.t('backMine') + '</a></p></div>';
  });
