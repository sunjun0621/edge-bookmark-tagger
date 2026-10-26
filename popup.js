const $ = id => document.getElementById(id);
let tabInfo = { url: '', title: '' };
let allPrefixes = [];
const RECENT_KEY = 'recentPrefix';      // 最近用过的前缀（供下拉排序）
const RECENT_KW_KEY = 'recentKeyword';  // 最近用过的关键词（供下拉）
const RECENT_MAX = 5;

// activeTab 权限下 query 可能拿不到 url，再补一次 get
async function currentTab() {
  let tab = null;
  try {
    const list = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = list && list[0];
  } catch (e) { console.warn(e); }
  if (tab && !tab.url && tab.id != null) {
    try { tab = await chrome.tabs.get(tab.id); } catch (e) { console.warn(e); }
  }
  return tab || {};
}

async function loadRecent() {
  try {
    const s = await chrome.storage.local.get(RECENT_KEY);
    return (s[RECENT_KEY] || []).slice(0, RECENT_MAX);
  } catch (e) { return []; }
}

async function loadRecentKw() {
  try {
    const s = await chrome.storage.local.get(RECENT_KW_KEY);
    return (s[RECENT_KW_KEY] || []).slice(0, RECENT_MAX);
  } catch (e) { return []; }
}

async function pushRecent(p) {
  if (!p) return;
  try {
    const list = (await loadRecent()).filter(x => x !== p);
    list.unshift(p);
    await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, RECENT_MAX) });
  } catch (e) { console.warn(e); }
}

async function pushRecentKw(k) {
  if (!k) return;
  try {
    const list = (await loadRecentKw()).filter(x => x !== k);
    list.unshift(k);
    await chrome.storage.local.set({ [RECENT_KW_KEY]: list.slice(0, RECENT_MAX) });
  } catch (e) { console.warn(e); }
}

// 用后台配置覆盖本地 FOLDERS（保持引用，rebuildPrefixMap 原地重填 PREFIX_FOLDER）
function applyFolders(list) {
  if (!Array.isArray(list) || !list.length) return;
  FOLDERS.length = 0;
  for (const g of list) FOLDERS.push({ name: g.name, prefixes: (g.prefixes || []).slice() });
  rebuildPrefixMap();
}

function defaultFolder() {
  const hit = FOLDERS.find(f => f.name === CONST.FALLBACK_FOLDER);
  if (hit) return hit.name;
  return FOLDERS.length ? FOLDERS[0].name : '';
}

function mappedFolder(prefix) {
  return PREFIX_FOLDER[prefix] || CUSTOM_PREFIX[prefix] || '';
}

function syncFolder() {
  $('folder').value = mappedFolder($('prefix').value.trim()) || defaultFolder();
}

function refreshOut() {
  const p = $('prefix').value.trim();
  const n = $('name').value.trim();
  const k = $('kw').value.trim();
  const title = buildTitle(p, n || CONST.UNNAMED, k || CONST.KW_DEFAULT);
  $('out').textContent = title;
  $('nameCnt').textContent = n.length + '/' + CONST.NAME_MAX;
  const note = $('note');
  if (note.dataset.mode === 'fixed') return;      // 保存结果 / 不支持页面：不被覆盖
  if (!p) { note.textContent = ''; return; }
  if (k && title.indexOf('｜') < 0) note.textContent = '关键词与名称重叠，已省略「｜关键词」';
  else if (n && title.indexOf(n) < 0) note.textContent = '名称尾部重复的关键词已剪掉';
  else note.textContent = '';
}

function setNote(text, fixed) {
  const note = $('note');
  note.textContent = text;
  note.dataset.mode = fixed ? 'fixed' : '';
}

function buildFolderSelect() {
  const sel = $('folder');
  sel.innerHTML = '';
  for (const g of FOLDERS) {
    const o = document.createElement('option');
    o.value = g.name;
    o.textContent = g.name;
    sel.appendChild(o);
  }
}

// 填充两个下拉：类别 + 用途（历史用过的）
// 只列名字本身：所属文件夹在下方「放进文件夹」里已经有了，下拉里再重复一遍只会干扰
// 最近使用过的排在前面，方便直接按 ↓ 选中
let KW_OPTIONS = [];
function buildPrefixList(groups, recentP, recentKw) {
  allPrefixes = [];
  const add = (p) => {
    if (!p || allPrefixes.includes(p)) return;
    allPrefixes.push(p);
  };
  // 最近用过的先放，其余按文件夹顺序
  for (const p of (recentP || [])) if (mappedFolder(p)) add(p);
  for (const g of groups) for (const p of g.prefixes) { if (p !== CONST.DUP_PREFIX) add(p); }
  for (const p of Object.keys(CUSTOM_PREFIX)) add(p);

  // 用途下拉：历史记录 + 规则里出现过的常用词
  KW_OPTIONS = [];
  const seen = new Set();
  const addKw = (k) => {
    const v = String(k || '').trim();
    if (!v || v === CONST.KW_DEFAULT || v === CONST.UNKNOWN_KW || seen.has(v)) return;
    seen.add(v);
    KW_OPTIONS.push(v);
  };
  for (const k of (recentKw || [])) addKw(k);
  for (const r of KEYWORD_RULES) addKw(r.kw);
  for (const k in DOMAIN_RULES) addKw(DOMAIN_RULES[k][2]);
}

// 文件夹名统一为「｜」后，首次打开提示一次
async function noticeOnce() {
  try {
    const s = await chrome.storage.local.get('sepNotice');
    if (s && s.sepNotice) {
      await chrome.storage.local.remove('sepNotice');
      setNote('文件夹名已统一为「｜」', true);
    }
  } catch (e) { console.warn(e); }
}

// 配置里有、书签栏里没有的文件夹：给一次性创建按钮
function checkMissing(folders, ids) {
  const miss = (folders || []).map(f => f.name).filter(n => !(ids && ids[n]));
  const box = $('fix');
  const btn = $('fixBtn');
  if (!miss.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  btn.disabled = false;
  btn.textContent = '创建缺失的文件夹（' + miss.length + '）';
  btn.title = miss.join('、');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '创建中…';
    const r = await chrome.runtime.sendMessage({ type: 'folderEnsure' });
    if (r && r.ok) {
      box.style.display = 'none';
      setNote('已创建：' + (r.created.join('、') || '无需创建'), true);
    } else {
      btn.disabled = false;
      btn.textContent = '重试创建缺失文件夹';
      setNote('创建失败：' + ((r && r.failed && r.failed.join('；')) || '未知错误'), true);
    }
  };
}

async function init() {
  const f = await chrome.runtime.sendMessage({ type: 'folders' });
  Object.assign(CUSTOM_PREFIX, (f && f.customs) || {});
  applyFolders(f && f.folders);
  buildFolderSelect();
  buildPrefixList((f && f.folders) || FOLDERS, await loadRecent(), await loadRecentKw());
  checkMissing(f && f.folders, f && f.ids);

  const tab = await currentTab();
  tabInfo = { url: tab.url || '', title: tab.title || '' };

  const supported = /^https?:/i.test(tabInfo.url);
  $('pageTitle').textContent = tabInfo.title || (supported ? '（无标题）' : '内部页面');
  $('pageTitle').title = tabInfo.title || '';
  $('pageUrl').textContent = tabInfo.url || '';
  $('pageUrl').title = tabInfo.url || '';

  if (!supported) {
    $('prefix').value = CONST.UNKNOWN_PREFIX;
    $('name').value = '扩展';
    $('kw').value = CONST.UNKNOWN_KW;
    syncFolder();
    refreshOut();
    $('save').disabled = true;
    setNote('这个页面不能收藏（只有普通网页可以）', true);
  } else {
    const r = await chrome.runtime.sendMessage({ type: 'preview', url: tabInfo.url, title: tabInfo.title });
    $('prefix').value = r.prefix || '';
    $('name').value = r.name || '';
    $('kw').value = r.kw || '';
    syncFolder();
    refreshOut();
  }

  await noticeOnce();
}

$('prefix').addEventListener('input', () => { syncFolder(); refreshOut(); });
$('name').addEventListener('input', refreshOut);
$('kw').addEventListener('input', refreshOut);
$('opt').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });

// ── 自绘下拉（替代原生 datalist：字体统一、条目多也不卡）──────────
// 每个输入框配一个列表；输入时按内容过滤，↑↓ 选、Enter 定、Esc 关
const COMBO = {
  prefix: { el: () => $('prefix'), box: () => $('prefixList'), items: () => allPrefixes, cur: -1 },
  kw: { el: () => $('kw'), box: () => $('kwList'), items: () => KW_OPTIONS, cur: -1 }
};

function comboClose(c) {
  c.box().classList.remove('on');
  c.box().innerHTML = '';
  c.cur = -1;
}

// 打开并渲染列表。刚聚焦时列全部（此时框里是预填值，拿它过滤只会剩一条，像坏了）
// 有输入时按包含关系过滤
function comboOpen(c, filterByInput) {
  const q = filterByInput ? c.el().value.trim().toLowerCase() : '';
  const all = c.items();
  const list = q ? all.filter(x => x.toLowerCase().includes(q)) : all;
  const box = c.box();
  box.innerHTML = '';
  c.cur = -1;
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = q ? '没有匹配的，直接回车保存新值' : '还没有可选项';
    box.appendChild(d);
  } else {
    // 列表可能很长（用途有 300 多项），限制渲染条数避免卡顿
    for (const v of list.slice(0, 200)) {
      const d = document.createElement('div');
      d.className = 'opt';
      d.textContent = v;
      d.addEventListener('mousedown', ev => {
        ev.preventDefault();          // 防止输入框先失焦
        c.el().value = v;
        comboClose(c);
        c.el().dispatchEvent(new Event('input'));
      });
      box.appendChild(d);
    }
  }
  box.classList.add('on');
  // 下方空间不够时翻到上方，免得浮层被弹出面板的边界裁掉
  const room = window.innerHeight - box.getBoundingClientRect().top;
  box.classList.toggle('up', room < Math.min(box.scrollHeight, 116) + 12);
}

// 高亮第 n 项并滚动到可见
function comboMove(c, step) {
  const box = c.box();
  const opts = [...box.querySelectorAll('.opt')];
  if (!opts.length) return;
  c.cur = (c.cur + step + opts.length) % opts.length;
  opts.forEach((o, i) => o.classList.toggle('cur', i === c.cur));
  opts[c.cur].scrollIntoView({ block: 'nearest' });
}

for (const key in COMBO) {
  const c = COMBO[key];
  const inp = c.el();
  inp.addEventListener('focus', () => comboOpen(c, false));
  inp.addEventListener('input', () => comboOpen(c, true));
  inp.addEventListener('blur', () => setTimeout(() => comboClose(c), 120));
  inp.addEventListener('keydown', e => {
    const on = c.box().classList.contains('on');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!on) comboOpen(c, false); else comboMove(c, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (on) comboMove(c, -1); return; }
    if (e.key === 'Escape') { if (on) { e.preventDefault(); comboClose(c); } return; }
    if (e.key === 'Enter') {
      const opts = c.box().querySelectorAll('.opt');
      if (on && c.cur >= 0 && opts[c.cur]) {
        e.preventDefault();
        inp.value = opts[c.cur].textContent;
        comboClose(c);
        inp.dispatchEvent(new Event('input'));
      }
    }
  });
}

// AI 填入：跳过规则，直接让 AI 推荐前缀 / 名称 / 关键词 / 文件夹，一次填满可改
$('aiFill').addEventListener('click', async () => {
  const btn = $('aiFill');
  if (!/^https?:/i.test(tabInfo.url)) { setNote('这个页面不能收藏（只有普通网页可以）', true); return; }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'AI 正在填…';
  setNote('');
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: 'suggest', url: tabInfo.url, title: tabInfo.title });
  } catch (e) {
    r = { ok: false, err: '消息通道异常：' + ((e && e.message) || e) };
  }
  btn.disabled = false;
  btn.textContent = old;
  if (!r || !r.ok) {
    setNote('AI 没填成功：' + ((r && r.err) || '未知原因'), true);
    return;
  }
  $('prefix').value = r.prefix || '';
  $('name').value = r.name || '';
  $('kw').value = r.kw || '';
  // 文件夹：AI 建议优先，其次按前缀映射，最后保持当前选择
  if (r.folder) $('folder').value = r.folder;
  else syncFolder();
  refreshOut();
  setNote('AI 已填好，可以再改');
});

$('save').addEventListener('click', async () => {
  const btn = $('save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  const prefix = $('prefix').value.trim();
  const folder = $('folder').value;
  const res = await chrome.runtime.sendMessage({
    type: 'apply',
    url: tabInfo.url,
    title: tabInfo.title,
    prefix,
    name: $('name').value.trim() || CONST.UNNAMED,
    kw: $('kw').value.trim() || CONST.KW_DEFAULT,
    folder
  });
  if (!res || !res.ok) {
    btn.disabled = false;
    btn.textContent = '保存并整理';
    setNote((res && res.msg) || '保存失败，请重试', true);
    return;
  }
  if (res.custom) CUSTOM_PREFIX[prefix] = folder;
  await pushRecent(prefix);
  await pushRecentKw($('kw').value.trim());
  btn.textContent = '已保存';
  $('out').textContent = res.title;
  setNote('已存进「' + (res.folder || '未移动') + '」' + (res.custom ? '，新类别已记住' : ''), true);
  setTimeout(() => window.close(), 900);
});

init();
