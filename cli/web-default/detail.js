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
var notesByHash = {}; // 本地学习笔记（/api/notes），按节点哈希分组；写入口=CLI（practi note）+ 右栏（POST /api/notes）
var hashByPath = {};  // nodeIndex 的逆映射（树内路径 → 哈希）；根（空路径）= HASH 本身
var notesOpen = false;  // 右栏开合：默认折叠；首载若本文档有笔记则自动展开（不持久化，每页按规则重判）
var notesTouched = false; // 用户本页手动开合过——之后自动规则不再介入
var draftByHash = {};   // 未落库的新建草稿（文档哈希 → 文本）：跨重渲染/导航存活，失焦有内容才落库
var noteErrorMsg = null; // 右栏写操作失败的一次性报错（下次动作或重渲染即清）

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

function notesFor(hash) {
  return notesByHash[hash] || [];
}

/** 当前节点哈希：根=HASH（URL 里那份），树内=逆登记簿 */
function hashAt(p) {
  return p.length ? hashByPath[p.join(',')] : HASH;
}

/** 大纲里的笔记数徽标：0 条不出现；点击=跳到该节点并展开笔记栏（点击委托 data-note-badge） */
function noteBadge(pathKey, count) {
  if (!count) return '';
  return '<span class="note-badge" data-note-badge data-path="' + pathKey + '">' + count + '</span>';
}

// ── 渲染 ──────────────────────────────────────────────

function render() {
  var app = document.getElementById('app');
  var node = walk(path);
  // 三视图：向导正文 / StandardView JSON / document JSON——侧栏大纲始终是导航脊柱，
  // 底部 Prev/Next 也常驻（在 JSON 视图里换节点=高亮跟着走）
  app.innerHTML = topbarHtml(node) + (view === 'wizard' ? nodeHtml(node) : jsonSectionHtml()) + navHtml();
  enhanceCodeBlocks(app);
  enhanceMedia(app);
  updateTabs();
  markSide();
  renderNoteSide(); // 右栏跟人走：每次导航换节点都重渲染（草稿保真在 renderNoteSide 内部处理）
  // 向导视图回顶（瞬移，既有行为）；JSON 视图平滑滚到当前高亮块首行。
  // 滚动容器是中间内容列自身（应用壳布局：整页不滚），原生 smooth 滚动天然可中断：
  // 快速连点不同节点时，新目标的滚动指令会取消进行中的动画，从当前位置转向新目标
  if (view === 'wizard') {
    app.scrollTop = 0;
  } else {
    var hl = document.querySelector('.json-pre .ln.hl');
    if (hl) hl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else app.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ── JSON 视图：pretty 渲染 + 当前节点高亮 ──
// document 视图：树即嵌套对象，当前节点 = walk(path) 的对象引用，按引用相等高亮（双胞胎只亮所在那份）
// StandardView 视图：practice 容器不进 steps，按「子树 steps 区段」高亮（steps 顺序与树遍历一致）；
// set 孩子的后代不递归聚合、天生不在视图里——老实不高亮

function jsonSectionHtml() {
  // label 行右侧复制按钮：复用 data-code-copy 委托（编码 JSON 文本）
  function labelRow(text, json) {
    return '<div class="label-row"><div class="label">' + POP_I18N.t(text) + '</div>' +
      '<button type="button" class="codeblock-copy json-copy" data-code-copy="' + encodeURIComponent(JSON.stringify(json, null, 2)) + '" aria-label="copy json">' + COPY_SVG + '</button></div>';
  }
  if (view === 'doc') {
    return '<div class="section-sm">' + labelRow('labelDocJson', doc) +
      '<pre class="json-pre">' + jsonHtml(doc, markDoc) + '</pre></div>';
  }
  if (svJson === null) {
    return '<div class="section-sm"><div class="label">' + POP_I18N.t('labelSvJson') + '</div><p class="op-note">' + POP_I18N.t('loading') + '</p></div>';
  }
  return '<div class="section-sm">' + labelRow('labelSvJson', svJson) +
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

/** 全树节点数（含根本身）——侧栏大纲列的就是节点（1、1.1…），统计行与之同口径；
 *  不叫 steps：steps 只对 op:seq 成立 */
function countNodes(n) {
  return 1 + (n.children || []).reduce(function (s, c) { return s + countNodes(c); }, 0);
}

/** 图标 tab（lucide list-todo/list-ordered/list-tree）：图标即按钮，名字进 tooltip 与 aria-label */
function tabIconBtn(view, tipKey, inner) {
  return '<button type="button" class="side-tab" data-view="' + view + '" data-tip="' + POP_I18N.t(tipKey) +
    '" aria-label="' + POP_I18N.t(tipKey) + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg></button>';
}

function sideHtml() {
  var total = countNodes(doc);
  // 视图三 tab 钉在侧栏最顶：向导正文 / StandardView JSON / document JSON（内容区随之换形态）
  var html = '<div class="side-tabs">' +
    tabIconBtn('wizard', 'tabWizard', '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><rect x="3" y="4" width="6" height="6" rx="1"/>') +
    tabIconBtn('sv', 'tabSv', '<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>') +
    tabIconBtn('doc', 'tabDoc', '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>') +
    '</div>' +
    '<p class="side-count">' + POP_I18N.t('nodeCount', total) + '</p>' +
    '<a href="#" class="side-item side-root" data-path="">' + escapeHtml(doc.name) + noteBadge('', notesFor(HASH).length) + '</a>';
  (function walkSide(n, prefix, depth, p) {
    (n.children || []).forEach(function (c, i) {
      var num = prefix + (i + 1);
      var cp = p.concat([i]);
      html += '<a href="#" class="side-item" data-path="' + cp.join(',') + '" style="padding-left:' + (14 + depth * 14) + 'px">' +
        '<span class="side-num">' + num + '</span>' + escapeHtml(c.name) + noteBadge(cp.join(','), notesFor(hashAt(cp)).length) + '</a>';
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
  if (node.type === 'action') html += outputsHtml(node);
  html += childrenHtml(node) + choiceHtml(node) + setHtml(node);
  // 笔记只住右侧栏（不进内容区）：revisions 已挪到左侧大纲底部（全文档汇总）；refines 同处
  return html;
}

// ── 学习笔记（/api/notes，本地 sidecar notes.json）──
// 呈现只住右侧笔记栏；内容区与 JSON 两视图不出现

/** ISO → 浏览器本地时区的 YYYY-MM-DD HH:mm（个人日记口径：时间属于看的人，不属于服务器） */
function fmtNoteTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 右侧笔记栏（#note-side）：当前节点的笔记工作台，常驻可增改删 ──
// 交互：点文本进入行内编辑、失焦即存（Esc 取消、清空=还原原文）；新建=头部按钮弹出
// 草稿（失焦有内容才落库，空=静默放弃——存储层不允许空笔记）。写入门之二
// （其一=CLI practi note）：POST /api/notes，CSRF 闸与 /api/run 同规格

var TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
var PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

/** 开合同步：面板宽度与内容列让位由 CSS transition 承担，这里只切类
 *  （body.note-open 让底部操作区同步让位，与内容列一起平滑重排） */
function applyNotesOpen() {
  var panel = document.getElementById('note-side');
  if (panel) panel.classList.toggle('open', notesOpen);
  document.body.classList.toggle('note-open', notesOpen);
}

/** 展开收起舌片：钉在面板左缘垂直居中（shell 内面板的相邻兄弟，right 与面板宽度
 *  同步过渡即贴合面板边）；收起后停在屏幕右缘仍可点 */
function wireNoteToggle() {
  var btn = document.getElementById('note-toggle');
  if (!btn) return;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  btn.setAttribute('aria-label', POP_I18N.t('notePanel'));
  btn.addEventListener('click', function () {
    notesOpen = !notesOpen;
    notesTouched = true;
    noteErrorMsg = null;
    renderNoteSide();
  });
}

function renderNoteSide() {
  var panel = document.getElementById('note-side');
  if (!panel) return;
  applyNotesOpen();
  reconcileNoteSide();
}

/** 面板渲染=把 DOM 对齐到服务端笔记。笔记本体是常驻可编辑的 textarea（无边框、
 *  自动长高，观感与正文一致）——没有「进入编辑态」这个动作，点了就有光标，失焦即存。
 *  重建时保留未落库的改动与聚焦位（SSE 重拉/语言切换/导航不打断打字） */
function reconcileNoteSide() {
  var panel = document.getElementById('note-side');
  if (!panel) return;
  applyNotesOpen();
  var list = document.getElementById('note-list');
  if (!list) return;
  var keep = {};      // 未落库改动的值（key=data-id）
  var activeKey = null, caret = null;
  list.querySelectorAll('[data-note-input]').forEach(function (ta) {
    var id = ta.getAttribute('data-id');
    if (!id) return; // 草稿的存活走 draftByHash，不进 keep
    var n = noteById(id);
    if (n && ta.value !== n.content) keep[id] = ta.value;
    if (document.activeElement === ta) { activeKey = id; caret = ta.selectionStart; }
  });
  var hash = hashAt(path);
  var notes = notesFor(hash);
  var draftValue = draftByHash.hasOwnProperty(hash) ? draftByHash[hash] : null;
  var count = notes.length + (draftValue !== null ? 1 : 0);
  var html = '<div class="nside-head"><p class="nside-title">' + POP_I18N.t('secNotes', count) + '</p>' +
    '<button type="button" class="nside-new" data-act="note-new" data-tip="' + escapeHtml(POP_I18N.t('noteNew')) + '" aria-label="' + escapeHtml(POP_I18N.t('noteNew')) + '">' + PLUS_ICON + '</button></div>';
  if (noteErrorMsg) html += '<p class="nside-err">' + escapeHtml(noteErrorMsg) + '</p>';
  if (!notes.length && draftValue === null) html += '<p class="nside-empty">' + escapeHtml(POP_I18N.t('noteEmpty')) + '</p>';
  html += notes.map(function (n) {
    var v = keep.hasOwnProperty(n.id) ? keep[n.id] : n.content;
    return '<div class="nside-item">' +
      '<div class="nside-meta"><span class="note-time">' + escapeHtml(fmtNoteTime(n.createdAt)) + '</span>' +
      '<span class="nside-acts">' +
      '<button type="button" class="nside-act" data-act="note-del" data-id="' + n.id + '" data-tip="' + escapeHtml(POP_I18N.t('noteDelete')) + '" aria-label="' + escapeHtml(POP_I18N.t('noteDelete')) + '">' + TRASH_ICON + '</button>' +
      '</span></div>' +
      '<textarea class="nside-input" data-note-input data-id="' + n.id + '">' + escapeHtml(v) + '</textarea></div>';
  }).join('');
  if (draftValue !== null) html += '<div class="nside-item"><textarea class="nside-input" data-note-input data-hash="' + escapeHtml(hash) + '">' + escapeHtml(draftValue) + '</textarea></div>';
  list.innerHTML = html;
  list.querySelectorAll('[data-note-input]').forEach(function (ta) {
    autoGrow(ta);
    var k = ta.getAttribute('data-id');
    if (activeKey === k) {
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch (e) { /* 类型输入框无 selection */ }
    }
  });
}

/** textarea 高度自适应内容（无边框伪装成正文的代价：得自己长个） */
function autoGrow(ta) {
  if (window.CSS && CSS.supports && CSS.supports('field-sizing', 'content')) return; // 原生自适应，JS 别插手
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function updateNoteCount() {
  var list = document.getElementById('note-list');
  if (!list) return;
  var n = notesFor(hashAt(path)).length + list.querySelectorAll('[data-note-input]:not([data-id])').length;
  var el = list.querySelector('.nside-title');
  if (el) el.textContent = POP_I18N.t('secNotes', n);
}

function postNote(body) {
  return fetch('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (j) {
      if (!r.ok) {
        var msg = j && j.error ? j.error : 'HTTP ' + r.status;
        // 裸 404（非 JSON 响应体）= 服务器没有这条路由：进程还在跑旧构建
        // （前端静态文件即时读盘是新的，web.ts 服务器代码是冷的——重启 practi web 即愈）
        if (!j && r.status === 404) msg += ' — ' + POP_I18N.t('noteServerStale');
        throw new Error(msg);
      }
      return j;
    });
  });
}

/** 所有笔记 POST 串行过同一队列：失焦保存与删除并发时不会互相覆盖 */
var noteQueue = Promise.resolve();
function queueNoteOp(fn) {
  var p = noteQueue.then(fn, fn);
  noteQueue = p.catch(function () {});
  return p;
}

function noteById(id) {
  var arr = notesFor(hashAt(path));
  for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
  return null;
}

function noteFail(e) {
  noteErrorMsg = String(e && e.message ? e.message : e);
  renderNoteSide();
}

function deleteNoteById(id, itemNode) {
  queueNoteOp(function () {
    return postNote({ op: 'delete', id: id }).then(function () {
      Object.keys(notesByHash).forEach(function (k) {
        notesByHash[k] = notesByHash[k].filter(function (x) { return x.id !== id; });
      });
      if (itemNode && itemNode.parentNode) itemNode.parentNode.removeChild(itemNode);
      document.getElementById('side').innerHTML = sideHtml(); // 徽标计数更新
      updateNoteCount();
    }).catch(function (e) { noteFail(e); });
  });
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
  // marked 在位（detail.html 引入 /marked.min.js）走全语法渲染；DIY 覆盖前端缺库时回落 lite
  if (typeof marked !== 'undefined' && marked.parse) {
    return sectionWrap(renderMarkdown(content, node));
  }
  return sectionWrap(proseLite(content, node));
}

// ── 围栏代码块增强：highlight.js 按语言高亮（未标注自动探测，relevance>=3 才信——
// 与 hub PopCodeBlock / D:/Dev/practi 桌面端同款逻辑），外包深色卡：
// 顶栏=语言标签 + 复制按钮（委托 data-code-copy）。hljs 缺库（DIY 覆盖前端）时跳过。
function enhanceCodeBlocks(root) {
  if (typeof hljs === 'undefined') return;
  var codes = root.querySelectorAll('.prose pre > code, .prose pre');
  for (var i = 0; i < codes.length; i++) {
    var el = codes[i];
    var pre = el.tagName === 'PRE' ? el : el.parentElement;
    if (!pre || pre.parentElement && pre.parentElement.classList.contains('codeblock')) continue;
    if (el.tagName !== 'CODE') {
      // proseLite 回落路径：<pre> 直接包文本——包一层 code 再走同一条路
      var codeEl = document.createElement('code');
      codeEl.textContent = pre.textContent;
      pre.textContent = '';
      pre.appendChild(codeEl);
      el = codeEl;
    }
    var raw = el.textContent.replace(/^[`]{3}[\w-]*\r?\n/, '').replace(/\r?\n[`]{3}$/, '');
    var m = /language-([\w-]+)/.exec(el.className);
    var lang = m && hljs.getLanguage(m[1]) ? m[1] : '';
    var detected = '';
    var html;
    if (lang) {
      html = hljs.highlight(raw, { language: lang }).value;
      detected = lang;
    } else {
      var r = hljs.highlightAuto(raw, AUTO_LANGS);
      html = r.value;
      detected = r.relevance >= 3 ? (r.language || '') : '';
    }
    var wrap = document.createElement('div');
    wrap.className = 'codeblock';
    var head = document.createElement('div');
    head.className = 'codeblock-head';
    head.innerHTML = '<span></span><button type="button" class="codeblock-copy" data-code-copy="' +
      encodeURIComponent(raw) + '" aria-label="copy code">' + COPY_SVG + '</button>';
    head.querySelector('span').textContent = detected;
    var newPre = document.createElement('pre');
    var newCode = document.createElement('code');
    newCode.className = 'hljs';
    newCode.innerHTML = html;
    newPre.appendChild(newCode);
    wrap.appendChild(head);
    wrap.appendChild(newPre);
    pre.parentElement.replaceChild(wrap, pre);
  }
}

// ── 内联媒体增强 + 灯箱：marked 输出的独占 <p><img></p> 与 proseLite 的 figure
// 统一成 figure.media，限高不撑爆内容列；图注（alt）走 data-tip 悬停气泡，
// 不再常驻图片下方。点击开灯箱看原图，滚轮在图片列表内循环切换。向导视图
// 一次只渲染一个节点，列表收集自当前内容区——天然只含本节点的图，滚不出其它节点 ──
function enhanceMedia(root) {
  var figs = [];
  var imgs = root.querySelectorAll('.prose img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    var fig = img.closest('figure');
    if (!fig) {
      // marked 路径：img 独占一个 <p> 才升格 figure（行内混排的小图不动）
      var p = img.parentElement;
      if (!p || p.tagName !== 'P' || p.childNodes.length !== 1) continue;
      fig = document.createElement('figure');
      p.replaceWith(fig);
      fig.appendChild(img);
    } else {
      // proseLite 路径自带 figcaption：文字转进 data-tip，元素撤下
      var capEl = fig.querySelector('figcaption');
      if (capEl) capEl.remove();
    }
    fig.classList.add('media');
    var alt = img.getAttribute('alt') || '';
    if (alt) fig.setAttribute('data-cap', alt); // 图注走跟随光标的浮层气泡（#media-tip）
    figs.push(fig);
  }
  for (var j = 0; j < figs.length; j++) {
    (function (fig, idx) {
      var im = fig.querySelector('img');
      // 悬停判定只挂 img：figure 占满整列，挂 figure 会让空白处也出气泡
      im.addEventListener('mouseenter', function (e) { showMediaTip(fig.getAttribute('data-cap'), e); });
      im.addEventListener('mousemove', function (e) { moveMediaTip(e); });
      im.addEventListener('mouseleave', hideMediaTip);
      im.addEventListener('click', function () {
        openLightbox(figs.map(function (f) { return f.querySelector('img'); }), idx);
      });
    })(figs[j], j);
  }
}

// 跟随光标的图注气泡：单例浮层 #media-tip，进出图片显示/隐藏、move 跟手
// （[data-tip]::after 是静态定位，跟不了光标；皮肤同款白底深蓝字）
function showMediaTip(text, e) {
  if (!text) return;
  var tip = ensureMediaTip();
  tip.textContent = text;
  tip.classList.add('show');
  moveMediaTip(e);
}
function moveMediaTip(e) {
  var tip = document.getElementById('media-tip');
  if (!tip || !tip.classList.contains('show')) return;
  // 避让光标：偏移 16/32，且靠近视口边时翻到另一侧（上→下、右→左），
  // 光标怎么移都不会压进气泡（气泡本身 pointer-events:none，只是视觉避让）
  var w = tip.offsetWidth, h = tip.offsetHeight;
  var x = e.clientX + 16;
  var y = e.clientY - h - 16;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
  if (y < 8) y = e.clientY + 20;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideMediaTip() {
  var tip = document.getElementById('media-tip');
  if (tip) tip.classList.remove('show');
}
function ensureMediaTip() {
  var tip = document.getElementById('media-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'media-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

var lbKeydown = null;

function openLightbox(list, idx) {
  closeLightbox();
  var cur = idx;
  var overlay = document.createElement('div');
  overlay.id = 'lightbox';
  var stage = document.createElement('img');
  var cap = document.createElement('div');
  cap.className = 'lb-cap';
  var count = document.createElement('div');
  count.className = 'lb-count';
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'lb-close';
  close.setAttribute('aria-label', 'close');
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  function draw() {
    var img = list[cur];
    stage.src = img.getAttribute('src');
    stage.alt = img.getAttribute('alt') || '';
    cap.textContent = img.getAttribute('alt') || '';
    count.textContent = (cur + 1) + ' / ' + list.length;
  }
  overlay.appendChild(close);
  overlay.appendChild(stage);
  overlay.appendChild(cap);
  overlay.appendChild(count);
  // 滚轮循环切换（down=下一张、up=上一张，头尾环绕）
  overlay.addEventListener('wheel', function (e) {
    e.preventDefault();
    cur = (cur + (e.deltaY > 0 ? 1 : list.length - 1)) % list.length;
    draw();
  }, { passive: false });
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay || e.target === close) closeLightbox();
  });
  lbKeydown = function (e) { if (e.key === 'Escape') closeLightbox(); };
  document.addEventListener('keydown', lbKeydown);
  document.body.appendChild(overlay);
  draw();
}

function closeLightbox() {
  var el = document.getElementById('lightbox');
  if (el) el.remove();
  if (lbKeydown) { document.removeEventListener('keydown', lbKeydown); lbKeydown = null; }
}

function flashCopied(btn) {
  if (btn.getAttribute('data-flashing') || btn.textContent.trim() !== '') return;
  btn.setAttribute('data-flashing', '1');
  btn.innerHTML = CHECK_SVG;
  setTimeout(function () {
    btn.innerHTML = COPY_SVG;
    btn.removeAttribute('data-flashing');
  }, 1500);
}

// 自动探测语言子集（与 hub PopCodeBlock 的 AUTO_LANGS 同步）：css/html/xml/markdown
// 极易误报（winget 命令被判成 css），排除后未命中就退回无标签
var AUTO_LANGS = ['bash', 'shell', 'powershell', 'json', 'javascript', 'typescript', 'python', 'sql', 'yaml', 'ini', 'rust', 'go', 'java', 'c', 'cpp', 'csharp', 'diff', 'makefile']
  .filter(function (l) { return hljs.getLanguage(l); });

var COPY_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
var CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// 轻量 toast（hub notify 同观感）：底部居中深色胶囊，1.6s 自动消退
function showToast(text) {
  var el = document.getElementById('web-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'web-toast';
    el.className = 'web-toast';
    document.body.appendChild(el);
  }
  el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg><span></span>';
  el.querySelector('span').textContent = text;
  el.classList.add('show');
  clearTimeout(el.__timer);
  el.__timer = setTimeout(function () { el.classList.remove('show'); }, 1600);
}

// ── 内容列顶栏（hub 同款）：返回（历史 back，兜底回目录）+ 文档信息弹窗。
// 本地文档没有状态/上传者/认领/浏览这些 hub 数据，弹窗只列节点数与根哈希 ──
var FP_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>';
var INFO_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
var CLIP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
var BACK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

/** 节点附件平铺（附件跟随节点：practice 无附件表，action 列自己的） */
function sizeLabel(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function collectAttachments(node) {
  var out = [];
  var atts = node && node.type === 'action' && node.attachments ? node.attachments : [];
  for (var i = 0; i < atts.length; i++) {
    var a = atts[i];
    out.push({
      name: a.name,
      href: a.url || ('/blobs/' + a.hash),
      meta: [a.mime, sizeLabel(a.size), a.hash ? shortHash(a.hash) : ''].filter(Boolean).join(' · ')
    });
  }
  return out;
}

function topbarHtml(node) {
  var atts = collectAttachments(node);
  var attachBtn = atts.length
    ? '<button type="button" class="topbar-btn" data-top="attach" aria-label="' + POP_I18N.t('docAttach') + '" data-tip="' + escapeHtml(POP_I18N.t('docAttach')) + '">' + CLIP_SVG + '<span>(' + atts.length + ')</span></button>'
    : '';
  return '<div class="detail-topbar">' +
    '<button type="button" class="topbar-btn" data-top="back">' + BACK_SVG + '<span>' + POP_I18N.t('back') + '</span></button>' +
    '<div class="topbar-right">' + attachBtn +
    '<button type="button" class="topbar-btn topbar-icon" data-top="info" aria-label="' + POP_I18N.t('metaInfo') + '" data-tip="' + escapeHtml(POP_I18N.t('metaInfo')) + '">' + INFO_SVG + '</button></div>' +
    '</div>';
}

/** 附件弹窗：固定尺寸，列表超出内滚（多附件不撑屏） */
function openAttDialog(node) {
  closeAttDialog();
  var atts = collectAttachments(node);
  var rows = atts.map(function (a) {
    return '<div class="att-row"><a href="' + escapeHtml(a.href) + '" target="_blank" rel="noopener">' + escapeHtml(a.name) + '</a>' +
      '<span class="att-meta">' + escapeHtml(a.meta) + '</span></div>';
  }).join('');
  var overlay = document.createElement('div');
  overlay.id = 'att-overlay';
  overlay.innerHTML =
    '<div class="info-card att-card" role="dialog" aria-label="' + POP_I18N.t('docAttach') + '">' +
    '<div class="info-head"><div class="info-title">' + POP_I18N.t('docAttach') + '</div>' +
    '<button type="button" class="info-close" aria-label="close">' + INFO_SVG + '</button></div>' +
    '<div class="att-scroll">' + rows + '</div>' +
    '</div>';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeAttDialog();
  });
  document.body.appendChild(overlay);
}

function closeAttDialog() {
  var el = document.getElementById('att-overlay');
  if (el) el.remove();
}

function openInfoDialog() {
  closeInfoDialog();
  var overlay = document.createElement('div');
  overlay.id = 'info-overlay';
  overlay.innerHTML =
    '<div class="info-card" role="dialog" aria-label="' + POP_I18N.t('metaInfo') + '">' +
    '<div class="info-head"><div class="info-title">' + POP_I18N.t('metaInfo') + '</div>' +
    '<button type="button" class="info-close" aria-label="close">' + INFO_SVG + '</button></div>' +
    '<div class="info-row"><span class="info-key">' + POP_I18N.t('nodeCount', countNodes(doc)) + '</span></div>' +
    '<button type="button" class="info-hash-btn" data-code-copy="' + encodeURIComponent(HASH) + '" title="' + POP_I18N.t('copied') + '">' +
    FP_SVG + '<span class="info-hash">' + escapeHtml(HASH) + '</span>' + COPY_SVG + '</button>' +
    '</div>';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeInfoDialog();
  });
  document.body.appendChild(overlay);
}

function closeInfoDialog() {
  var el = document.getElementById('info-overlay');
  if (el) el.remove();
}

function sectionWrap(body) {
  return '<div class="section-sm"><div class="label">' + POP_I18N.t('secContent') + '</div><div class="prose">' + body + '</div></div>';
}

/** content → HTML：对齐 hub MarkdownView（CommonMark+GFM，marked v15 vendored）。
 *  安全口径同 react-markdown 默认：内联 HTML 一律按文本显示——渲染前预转义 &<>，
 *  marked 只做语法渲染；mailto 自动链接降级为文本（hub 同款规则） */
function renderMarkdown(content, node) {
  var src = content.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, function (whole, alt, target) {
    var url = mediaUrl(target, node);
    // 未命中的图片引用整段按文本保留（转义 markdown 控制符）
    if (url === null) return whole.replace(/([!\[\]()\\])/g, '\\$1');
    return '![' + alt + '](' + url + ')';
  });
  // 只转义 < 与 &（足以挡内联 HTML 注入）；> 保留——行首 "> " 是块引用语法
  src = src.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  var html = marked.parse(src, { gfm: true, breaks: false, async: false });
  // marked 在 code 段内会把预转义产生的 & 再转一次（&lt; 变 &amp;lt;，页面显示字面
  // &lt;）——code 段内 &amp; 还原回 &：预转义的 &lt; 复原、原文的字面 & 仍只剩一层
  html = html.replace(/(<code[^>]*>)([\s\S]*?)(<\/code>)/g, function (m0, open, body, close) {
    return open + body.replace(/&amp;/g, '&') + close;
  });
  return html.replace(/<a href="mailto:[^"]*">([^<]*)<\/a>/g, '$1');
}

function proseLite(content, node) {
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
  return out.replace(/\u0000B(\d+)\u0000/g, function (_, i) {
    return '<pre>' + escapeHtml(blocks[Number(i)]) + '</pre>';
  });
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

// 正文的附件小节已撤（信息进顶栏附件按钮弹窗，附件跟随节点）

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
  var top = e.target.closest('[data-top]');
  if (top) {
    if (top.getAttribute('data-top') === 'back') {
      if (history.length > 1) history.back();
      else location.href = '/';
    } else if (top.getAttribute('data-top') === 'info') {
      openInfoDialog();
    } else if (top.getAttribute('data-top') === 'attach') {
      openAttDialog(walk(path));
    }
    return;
  }
  if (e.target.closest('#info-overlay .info-close')) {
    closeInfoDialog();
    return;
  }
  if (e.target.closest('#att-overlay .info-close')) {
    closeAttDialog();
    return;
  }
  var copyBtn = e.target.closest('[data-code-copy]');
  if (copyBtn) {
    var text = decodeURIComponent(copyBtn.getAttribute('data-code-copy'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flashCopied(copyBtn);
        showToast(POP_I18N.t('copied'));
      }, function () {});
    }
    return;
  }
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
  var nbadge = e.target.closest('[data-note-badge]');
  if (nbadge) {
    // 徽标语义=看这条节点的笔记：跳转交给下面的 data-path，这里负责展开右栏
    if (!notesOpen) {
      notesOpen = true;
      notesTouched = true;
      renderNoteSide();
    }
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
  if (a === 'note-new') {
    // 新建=在列表末尾补一个草稿框（已有草稿就聚焦它）；失焦有内容才落库
    var list = document.getElementById('note-list');
    if (!list) return;
    var existing = list.querySelector('[data-note-input]:not([data-id])');
    if (existing) { existing.focus(); return; }
    var item = document.createElement('div');
    item.className = 'nside-item';
    item.innerHTML = '<textarea class="nside-input" data-note-input></textarea>';
    list.appendChild(item);
    var ta = item.querySelector('textarea');
    ta.focus();
    updateNoteCount();
    return;
  }
  if (a === 'note-del') {
    // 写写相碰：进串行队列等当前失焦保存落库后再删，防并发读改写互相覆盖
    var id = act.getAttribute('data-id');
    var item = act.closest('.nside-item');
    queueNoteOp(function () {
      return postNote({ op: 'delete', id: id }).then(function () {
        Object.keys(notesByHash).forEach(function (k) {
          notesByHash[k] = notesByHash[k].filter(function (x) { return x.id !== id; });
        });
        if (item && item.parentNode) item.parentNode.removeChild(item);
        document.getElementById('side').innerHTML = sideHtml(); // 徽标计数更新
        updateNoteCount();
      }).catch(function (e) { noteFail(e); });
    });
    return;
  }
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

// 右栏键盘（textarea 常驻可编辑）：Ctrl/Cmd+Enter 立即失焦保存，Esc 还原原文/放弃草稿
document.addEventListener('DOMContentLoaded', function () {
  var list = document.getElementById('note-list');
  if (!list) return;
  list.addEventListener('keydown', function (e) {
    var ta = e.target;
    if (!ta.matches || !ta.matches('[data-note-input]')) return;
    if (e.key === 'Escape') {
      var id = ta.getAttribute('data-id');
      if (id) {
        var n = noteById(id);
        if (n) ta.value = n.content; // 还原原文
      } else {
        ta.value = '';               // 草稿：清空
      }
      autoGrow(ta);
      ta.blur(); // focusout 委托统一收口（未改动/空草稿都不会落库）
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      ta.blur();
    }
  });
  // 输入即长高
  list.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('[data-note-input]')) autoGrow(e.target);
  });
  // 失焦即存：blur 不冒泡、focusout 冒泡，委托在列表上（innerHTML 重建不丢监听）
  list.addEventListener('focusout', function (e) {
    var ta = e.target;
    if (!ta.matches || !ta.matches('[data-note-input]')) return;
    var id = ta.getAttribute('data-id');
    if (id) {
      var n = noteById(id);
      if (!n) return;
      if (ta.value === n.content) return;                                // 未改动
      if (!ta.value.trim()) { ta.value = n.content; autoGrow(ta); return; } // 清空=还原原文
      var content = ta.value;
      queueNoteOp(function () {
        return postNote({ op: 'edit', id: id, content: content }).then(function (j) {
          n.content = content;
          if (j.note && j.note.updatedAt) n.updatedAt = j.note.updatedAt;
        }).catch(function (err) { noteFail(err); });
      });
    } else {
      var hash = ta.getAttribute('data-hash') || hashAt(path);
      if (!ta.value.trim()) {                                            // 空草稿=放弃
        var item = ta.closest('.nside-item');
        if (item) item.remove();
        delete draftByHash[hash];
        updateNoteCount();
        return;
      }
      draftByHash[hash] = ta.value;                                      // 先记着：POST 在途时重渲染不丢
      var content2 = ta.value;
      queueNoteOp(function () {
        return postNote({ op: 'add', hash: hash, content: content2 }).then(function (j) {
          var note = j.note;
          if (note) (notesByHash[hash] = notesByHash[hash] || []).push(note);
          delete draftByHash[hash];
          ta.setAttribute('data-id', note.id);
          document.getElementById('side').innerHTML = sideHtml();        // 徽标 0→N
          updateNoteCount();
        }).catch(function (err) { noteFail(err); });
      });
    }
  });
});

// 右栏舌片事件接线（元素静态在 HTML；提示文案等 lang.js 就绪，故挂 DOMContentLoaded）
document.addEventListener('DOMContentLoaded', function () {
  wireNoteToggle();
  applyNotesOpen();
});

// 语言切换：侧栏大纲与内容区一并重绘
POP_I18N.onChange(function () {
  if (doc) document.getElementById('side').innerHTML = sideHtml();
  render();
});

var HASH = decodeURIComponent((location.pathname.split('/pop/')[1] || '').replace(/\.json$/, ''));

// nodeIndex（哈希→路径）逆成 hashByPath（路径→哈希）：笔记按哈希钉，侧栏/节点卡按路径定位
function buildHashByPath() {
  hashByPath = {};
  if (!nodeIndex) return;
  for (var h in nodeIndex) hashByPath[nodeIndex[h].join(',')] = h;
}

/** 笔记到货后的重绘：只动左右两栏（侧栏徽标 + 右栏），内容区不碰——
 *  笔记不进内容区，动它只会带来无谓的重绘与闪烁。
 *  侧栏是整段 innerHTML 重建，重建后必须补回 tab 选中态与当前节点高亮 */
function onNotesArrived() {
  if (!doc) return;
  document.getElementById('side').innerHTML = sideHtml();
  updateTabs();
  markSide();
  renderNoteSide();
}

function loadNotesData() {
  fetch('/api/notes?ref=' + encodeURIComponent(HASH))
    .then(function (r) { return r.ok ? r.json() : { notes: [] }; })
    .then(function (j) {
      notesByHash = {};
      (j.notes || []).forEach(function (n) {
        (notesByHash[n.hash] = notesByHash[n.hash] || []).push(n);
      });
      // 默认折叠；首载本文档有笔记则自动展开（用户手动开合过就不再自动介入）
      if (!notesTouched && (j.notes || []).length) notesOpen = true;
      onNotesArrived();
    })
    .catch(function () { /* 笔记是锦上添花：拉取失败静默，文档照常显示 */ });
}

// 另一终端写笔记（CLI/别的页面）→ 服务器发 notes 轻事件 → 只重拉笔记，绝不整刷。
// reconcile 会保留未落库改动与聚焦位，编辑中收到推送也不丢字
document.addEventListener('practi:notes', function () {
  loadNotesData();
});

fetch('/doc/' + encodeURIComponent(HASH) + '.json')
  .then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(function (d) {
    // 数据窗=加法演进：树字段在顶层，nodeIndex 是后加的兄弟键（老响应没有它 → 哈希兜底）
    doc = d;
    nodeIndex = d.nodeIndex || null;
    buildHashByPath();
    document.title = doc.name + ' — practi';
    document.getElementById('side').innerHTML = sideHtml();
    render();
    loadNotesData();
  })
  .catch(function (err) {
    document.getElementById('app').innerHTML =
      '<div class="empty"><p class="lead">' + POP_I18N.t('docFail', escapeHtml(String(err.message || err))) + '</p>' +
      '<p class="hint"><a href="/">' + POP_I18N.t('backMine') + '</a></p></div>';
  });
