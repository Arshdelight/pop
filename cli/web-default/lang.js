// practi web 语言层：中英双语（默认中文），偏好存 localStorage（每浏览器各记各的）。
// 设置入口（header 右上角齿轮 + 固定大小弹窗）由本文件注入，目录页/详情页共用；
// app.js / detail.js 消费 t() 并用 onChange 注册重渲染。tab 名与 JSON 视图标题是
// 术语（Wizard/StandardView/Document JSON），不参与翻译。
'use strict';

var POP_I18N = (function () {
  var KEY = 'practi.lang';

  // 字典值：字符串，或函数（复数/拼接类文案按参数生成）
  var M = {
    zh: {
      settings: '设置', language: '语言', done: '完成',
      tabWizard: '步骤', tabSv: '标准视图', tabDoc: '文档树',
      labelDocJson: '文档 JSON', labelSvJson: 'StandardView JSON',
      // 目录页
      pageTitle: '我的实践',
      thDocument: '文档', thSteps: '步骤', thAdded: '添加时间',
      emptyLead: '还没有记录。写下第一手实践经验，成为一份 POP 文档——哈希可验证，永久保存。',
      emptyHint: '用 <code>practi new</code> 创建',
      countDocs: function (n) { return n + ' 篇文档'; },
      pageOf: function (a, b) { return '第 ' + a + ' / ' + b + ' 页'; },
      pagerPrev: '上一页', pagerNext: '下一页',
      loadFail: '加载失败（/api/directs）',
      // 详情页
      stepCount: function (n) { return n + ' 个步骤'; },
      loading: '加载中…',
      opPar: '以下任务并行执行——顺序无关',
      opChoice: '选择一个分支继续',
      opSet: '独立小节——可自由跳转，无顺序',
      secContent: '正文', secInputs: '输入', secOutputs: '输出', secAttachments: '附件',
      secSteps: function (n) { return '步骤 (' + n + ')'; },
      secTasks: function (n) { return '任务 (' + n + ')'; },
      secOptions: function (n) { return '选项 (' + n + ')'; },
      secItems: function (n) { return '条目 (' + n + ')'; },
      repeatX: function (n) { return '重复 ×' + n; },
      repeatUntil: function (s) { return '重复直到：' + s; },
      repeat: '重复',
      wizardPrev: '上一步', next: '下一步',
      chooseBranch: '选择一个分支继续',
      endPractice: '实践完结',
      revisions: function (n) { return '修订 (' + n + ')'; },
      refines: function (n) { return '改进 (' + n + ')'; },
      secNotes: function (n) { return '笔记 (' + n + ')'; },
      notePanel: '笔记',
      noteNew: '新建',
      notePlaceholder: '写点什么…（失焦保存，Esc 取消）',
      noteClickEdit: '点击编辑',
      noteDelete: '删除',
      noteEmpty: '这条节点还没有笔记，点上方「新建」写一条。',
      noteServerStale: '服务器像是旧构建（前端新、服务器旧）——重启 practi web 再试',
      docFail: function (s) { return '文档加载失败（' + s + '）'; },
      backMine: '← 我的实践'
    },
    en: {
      settings: 'Settings', language: 'Language', done: 'Done',
      tabWizard: 'Todo', tabSv: 'StandardView', tabDoc: 'Document',
      labelDocJson: 'Document JSON', labelSvJson: 'StandardView JSON',
      pageTitle: 'My practices',
      thDocument: 'Document', thSteps: 'Steps', thAdded: 'Added',
      emptyLead: 'Nothing recorded yet. Write first-hand experience as a POP document — verifiable by hash, forever.',
      emptyHint: 'create one with <code>practi new</code>',
      countDocs: function (n) { return n + (n === 1 ? ' document' : ' documents'); },
      pageOf: function (a, b) { return 'page ' + a + ' of ' + b; },
      pagerPrev: 'Previous', pagerNext: 'Next',
      loadFail: 'failed to load /api/directs',
      stepCount: function (n) { return n + (n === 1 ? ' step' : ' steps'); },
      loading: 'loading…',
      opPar: 'the tasks below run in parallel — order does not matter',
      opChoice: 'pick one branch to continue',
      opSet: 'independent sections — jump freely, no ordering',
      secContent: 'content', secInputs: 'inputs', secOutputs: 'outputs', secAttachments: 'attachments',
      secSteps: function (n) { return 'steps (' + n + ')'; },
      secTasks: function (n) { return 'tasks (' + n + ')'; },
      secOptions: function (n) { return 'options (' + n + ')'; },
      secItems: function (n) { return 'items (' + n + ')'; },
      repeatX: function (n) { return 'repeat ×' + n; },
      repeatUntil: function (s) { return 'repeat until: ' + s; },
      repeat: 'repeat',
      wizardPrev: 'Prev', next: 'Next',
      chooseBranch: 'choose a branch to continue',
      endPractice: 'end of practice',
      revisions: function (n) { return 'revisions (' + n + ')'; },
      refines: function (n) { return 'refines (' + n + ')'; },
      secNotes: function (n) { return 'notes (' + n + ')'; },
      notePanel: 'Notes',
      noteNew: 'New',
      notePlaceholder: 'write anything… (blur to save, Esc to cancel)',
      noteClickEdit: 'Click to edit',
      noteDelete: 'Delete',
      noteEmpty: 'No notes on this node yet — click New above to write one.',
      noteServerStale: 'the server looks like an older build — restart practi web and retry',
      docFail: function (s) { return 'failed to load document (' + s + ')'; },
      backMine: '← My practices'
    }
  };

  function getLang() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { /* 隐私模式等：内存态即可 */ }
    return v === 'en' || v === 'zh' ? v : 'zh';
  }

  function t(key) {
    var lang = M[getLang()];
    var v = lang[key] !== undefined ? lang[key] : M.zh[key];
    if (v === undefined) return key;
    if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
    return v;
  }

  var listeners = [];
  function onChange(fn) { listeners.push(fn); }

  function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* 同上 */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  // ── 设置入口：header 右上角齿轮 + 固定大小弹窗（语言选择）──
  function mountSettings() {
    var header = document.querySelector('header');
    if (!header) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn';
    btn.setAttribute('aria-label', 'settings');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' +
      '<circle cx="12" cy="12" r="3"/></svg>';
    header.appendChild(btn);

    var overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML =
      '<div class="settings-dialog" role="dialog" aria-label="settings">' +
      '<p class="settings-title"></p>' +
      '<div class="settings-body">' +
      '<p class="settings-field"></p>' +
      '<div class="settings-langs">' +
      '<button type="button" class="settings-lang" data-lang="zh">中文</button>' +
      '<button type="button" class="settings-lang" data-lang="en">English</button>' +
      '</div></div>' +
      '<div class="settings-foot"><button type="button" class="btn settings-done"></button></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var title = overlay.querySelector('.settings-title');
    var field = overlay.querySelector('.settings-field');
    var done = overlay.querySelector('.settings-done');

    function syncText() {
      title.textContent = t('settings');
      field.textContent = t('language');
      done.textContent = t('done');
      var cur = getLang();
      var btns = overlay.querySelectorAll('.settings-lang');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-lang') === cur);
    }

    function open() { syncText(); overlay.classList.add('open'); }
    function close() { overlay.classList.remove('open'); }

    btn.addEventListener('click', open);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
      var langBtn = e.target.closest('.settings-lang');
      if (langBtn) { setLang(langBtn.getAttribute('data-lang')); syncText(); }
    });
    overlay.querySelector('.settings-done').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
    mountSettings();
  });

  return { t: t, getLang: getLang, setLang: setLang, onChange: onChange };
})();
