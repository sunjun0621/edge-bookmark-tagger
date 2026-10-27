const $ = id => document.getElementById(id);
let FOLDER_LIST = [];

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function showOut(id, text) {
  const box = $(id);
  box.textContent = text;
  box.style.display = 'block';
}

function flashSaved() {
  const s = $('saved');
  s.classList.add('on');
  setTimeout(() => s.classList.remove('on'), 1500);
}

async function load() {
  const c = await chrome.storage.local.get(null);
  $('enabled').checked = c.enabled !== false;
  $('dedupe').checked = c.dedupe !== false;
  $('useai').checked = c.useai !== false;
  $('aibase').value = c.aibase || 'https://api.deepseek.com/v1';
  $('aimodel').value = c.aimodel || 'deepseek-chat';
  $('apikey').value = c.apikey || '';
  $('unknown').value = c.unknown || CONST.UNKNOWN_PREFIX;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    enabled: $('enabled').checked,
    dedupe: $('dedupe').checked,
    useai: $('useai').checked,
    aibase: $('aibase').value.trim(),
    aimodel: $('aimodel').value.trim(),
    apikey: $('apikey').value.trim(),
    unknown: $('unknown').value
  });
  flashSaved();
});

// ── 规则自测 ──────────────────────────────
$('test').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'preview', url: $('tUrl').value.trim(), title: $('tTitle').value.trim() });
  const pix = r.prefix;
  const to = PREFIX_FOLDER[pix] || CUSTOM_PREFIX[pix] || '';
  showOut('testOut', `${r.title}\n判断依据：${r.source}\n放进：${to || '（没找到对应文件夹）'}`);
});

// ── 维护：查看文件夹 ID ────────────────────
$('reload').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'folders' });
  const lines = Object.entries(r.ids).map(([k, v]) => `${k}  →  ${v}`);
  const miss = ((r && r.folders) || []).map(f => f.name).filter(n => !r.ids[n]);
  if (miss.length) lines.push('配置里有但书签栏找不到：' + miss.join('、'));
  showOut('folderOut', lines.join('\n') || '未找到任何一级文件夹，请先导入整理后的书签文件。');
});

// ── 规则导入导出 ───────────────────────────
$('expBtn').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'rulesExport' });
  if (!r || !r.ok) { showOut('impOut', '导出失败，请重新加载扩展后再试'); return; }
  const d = r.data;
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bookmark-rules-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showOut('impOut', '已导出：按网址 ' + Object.keys(d.domainRules).length + ' 条，关键词 ' + d.keywordRules.length +
    ' 条，文件夹 ' + d.folders.length + ' 个。');
});

$('impBtn').addEventListener('click', () => $('impFile').click());

$('impFile').addEventListener('change', async () => {
  const f = $('impFile').files && $('impFile').files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || (!data.domainRules && !data.keywordRules)) throw new Error('不是本扩展导出的规则文件');
    const r = await chrome.runtime.sendMessage({
      type: 'rulesImport',
      patch: { domainRules: data.domainRules || {}, keywordRules: data.keywordRules || [] }
    });
    if (!r || !r.ok) throw new Error('导入失败');
    showOut('impOut', '已导入：网址规则 ' + r.domain + ' 条，新增关键词 ' + r.keyword + ' 条。\n现在共 ' +
      r.total.domain + ' 条网址规则 / ' + r.total.keyword + ' 条关键词规则。');
  } catch (e) {
    showOut('impOut', '导入失败：' + ((e && e.message) || e));
  }
  $('impFile').value = '';
});

// ── 类别一览（查询 / 新增 / 删除 / 换文件夹）─────────
// 按文件夹分组、类别显示成 chip；点 chip 弹操作浮层。
// 旧版每行挂一个原生 select，五十多个类别就是五十多个重量级控件，搜索一敲全销毁重建——又卡又难找。
let CATS = [];

async function loadCats() {
  const r = await chrome.runtime.sendMessage({ type: 'catList' });
  CATS = (r && r.items) || [];
  renderCats();
}

function renderCats() {
  const box = $('catList');
  const q = ($('catSearch').value || '').trim().toLowerCase();
  const onlyMine = $('catOnlyMine').checked;
  let items = CATS;
  if (onlyMine) items = items.filter(x => !x.builtin);
  if (q) items = items.filter(x => x.name.toLowerCase().includes(q));

  box.innerHTML = '';
  const frag = document.createDocumentFragment();

  // 按文件夹分组，组序跟随文件夹配置；自己的类别在组内排前面
  const byFolder = {};
  for (const x of items) (byFolder[x.folder] = byFolder[x.folder] || []).push(x);
  const order = FOLDER_LIST.map(f => f.name);
  const groups = order.filter(n => byFolder[n]).map(n => [n, byFolder[n]]);
  for (const n in byFolder) if (order.indexOf(n) < 0) groups.push([n, byFolder[n]]);

  if (!groups.length) {
    const d = el('div', 'cat-empty',
      q ? '没有匹配的类别' : (onlyMine ? '你还没有自己加过类别' : '还没有类别'));
    frag.appendChild(d);
    box.appendChild(frag);
    return;
  }

  // 空文件夹提示：配置里有、但一个类别都没有的文件夹不会出现在上面的分组里，
  // 容易让人以为"加的东西没了"。这里直接列出来并给个删除入口。
  const emptyFolders = FOLDER_LIST.filter(f => !f.prefixes || !f.prefixes.length);
  if (emptyFolders.length && !onlyMine && !q) {
    const w = el('div', 'cat-empty-folder');
    w.appendChild(el('span', null, '这些文件夹还没有类别：' + emptyFolders.map(f => f.name).join('、')));
    for (const f of emptyFolders) {
      const b = el('button', 'ghost', '删掉「' + f.name + '」');
      b.type = 'button';
      b.addEventListener('click', async () => {
        if (!confirm('把文件夹「' + f.name + '」从配置里移除？\n\n书签栏里的真实目录和里面已有的书签都不会删。')) return;
        const r = await chrome.runtime.sendMessage({ type: 'folderDel', name: f.name });
        if (!r || !r.ok) { $('catErr').textContent = (r && r.msg) || '删除失败'; return; }
        $('catErr').className = 'err ok';
        $('catErr').textContent = '已移除文件夹「' + f.name + '」';
        await loadFolders();
        await loadCats();
      });
      w.appendChild(b);
    }
    frag.appendChild(w);
  }

  for (const [folder, arr] of groups) {
    const g = el('div', 'cat-group');
    const h = el('div', 'cat-group-h');
    h.appendChild(el('b', null, folder));
    h.appendChild(el('span', null, '　' + arr.length + ' 个'));
    const chips = el('div', 'cat-chips');
    arr.sort((a, b) => (a.builtin === b.builtin) ? 0 : (a.builtin ? 1 : -1));
    for (const x of arr) {
      const chip = el('button', 'cat-chip' + (x.builtin ? '' : ' mine'), x.name);
      chip.type = 'button';
      chip.dataset.cat = x.name;
      chip.title = '点击移动或删除';
      chip.addEventListener('click', () => toggleCatPop(x, chip));
      chips.appendChild(chip);
    }
    g.appendChild(h);
    g.appendChild(chips);
    frag.appendChild(g);
  }
  box.appendChild(frag);
}

// ── 类别操作浮层 ────────────────────────────
let catPopFor = null;   // 当前浮层对应的类别
let catPopAnchor = null;

function closeCatPop() {
  const pop = document.getElementById('catPop');
  if (pop) pop.remove();
  if (catPopAnchor) catPopAnchor.classList.remove('on');
  catPopFor = null;
  catPopAnchor = null;
}

// 浮层定位：贴着 chip 下方；贴不下就翻到上方；左右不超出窗口
function placeCatPop() {
  const pop = document.getElementById('catPop');
  if (!pop || !catPopAnchor) return;
  const r = catPopAnchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 12));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

function toggleCatPop(x, anchor) {
  if (catPopFor && catPopFor.name === x.name && catPopAnchor === anchor) { closeCatPop(); return; }
  closeCatPop();
  catPopFor = x;
  catPopAnchor = anchor;

  const pop = el('div', 'cat-pop');
  pop.id = 'catPop';

  pop.appendChild(el('div', 'p-name', x.name));
  const sub = (x.builtin ? '自带类别' : '我加的类别') + (x.rules ? ' · ' + x.rules + ' 条规则在用' : ' · 暂无规则在用');
  pop.appendChild(el('div', 'p-sub', sub));

  pop.appendChild(el('div', 'p-h', '移动到'));
  for (const f of FOLDER_LIST) {
    const b = el('button', 'p-folder' + (f.name === x.folder ? ' cur' : ''), f.name);
    b.type = 'button';
    if (f.name === x.folder) b.disabled = true;
    b.addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'catMove', name: x.name, folder: f.name });
      closeCatPop();
      if (!r || !r.ok) { $('catErr').textContent = (r && r.msg) || '移动失败'; return; }
      $('catErr').className = 'err ok';
      $('catErr').textContent = '「' + x.name + '」已移到「' + f.name + '」';
      await loadCats();
      await loadFolders();
    });
    pop.appendChild(b);
  }

  // 兜底类别（认不出的网页 / 重复链接）必须留着，收藏时才有着落
  const isFallback = x.name === CONST.UNKNOWN_PREFIX || x.name === CONST.DUP_PREFIX;
  if (!isFallback) {
    const d = el('button', 'p-del', '删除这个类别');
    d.type = 'button';
    d.addEventListener('click', async () => {
      const tip = x.builtin && x.rules
        ? '\n\n它现在有 ' + x.rules + ' 条规则在用，删掉后这些规则也会一起停用（可在「自动归类规则」里看到）。'
        : '';
      if (!confirm('删除类别「' + x.name + '」？' + tip + '\n\n已有书签不受影响。')) return;
      const r = await chrome.runtime.sendMessage({ type: 'catDel', name: x.name });
      closeCatPop();
      if (!r || !r.ok) { $('catErr').textContent = (r && r.msg) || '删除失败'; return; }
      $('catErr').className = 'err ok';
      $('catErr').textContent = '已删除「' + x.name + '」' +
        (r.rules ? '，同时停用 ' + r.rules + ' 条规则' : '');
      await loadCats();
      await loadFolders();
      await loadRules();
    });
    pop.appendChild(d);
  }

  document.body.appendChild(pop);
  catPopAnchor.classList.add('on');
  pop.style.visibility = 'hidden';
  pop.classList.add('on');
  placeCatPop();
  pop.style.visibility = '';
}

// 点浮层外面、按 Esc 收起。
// 列表滚动不再收起浮层：滚动惯性尚未停下时点 chip，浮层会刚出现就被关掉，
// 看起来像「点了没反应」。改为滚动时跟着 chip 重新定位，滚动停止后仍贴合。
document.addEventListener('mousedown', e => {
  if (!catPopFor) return;
  if (e.target.id === 'catPop' || (e.target.closest && e.target.closest('#catPop'))) return;
  if (e.target.closest && e.target.closest('.cat-chip')) return;
  closeCatPop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && catPopFor) closeCatPop(); });
document.getElementById('catList').addEventListener('scroll', () => { if (catPopFor) placeCatPop(); }, { passive: true });
window.addEventListener('resize', () => { if (catPopFor) placeCatPop(); });

// 搜索框防抖：类别与规则都有几百条，每敲一个键就全量重建 DOM 会卡
function debounce(fn, wait) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, wait); };
}
const renderCatsSoon = debounce(renderCats, 120);
$('catSearch').addEventListener('input', renderCatsSoon);
$('catOnlyMine').addEventListener('change', renderCats);

$('catAdd').addEventListener('click', async () => {
  const err = $('catErr');
  err.className = 'err';
  err.textContent = '';
  const name = $('catName').value.trim();
  const r = await chrome.runtime.sendMessage({ type: 'catAdd', name, folder: $('catFolder').value });
  if (!r || !r.ok) { err.textContent = (r && r.msg) || '新增失败'; return; }
  $('catName').value = '';
  err.className = 'err ok';
  err.textContent = '已新增「' + r.name + '」，放进「' + r.folder + '」';
  await loadCats();
  await loadFolders();
});

$('catName').addEventListener('keydown', e => { if (e.key === 'Enter') $('catAdd').click(); });

function buildFolderSelects(keepCp, keepPb) {
  for (const pair of [['catFolder', keepCp]]) {
    const sel = $(pair[0]);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const g of FOLDER_LIST) {
      const o = el('option', null, g.name);
      o.value = g.name;
      sel.appendChild(o);
    }
    if (pair[1] && FOLDER_LIST.some(g => g.name === pair[1])) sel.value = pair[1];
  }
}

// ── 一级文件夹 ─────────────────────────────
function renderFolders() {
  const box = $('fdList');
  box.innerHTML = '';
  if (!FOLDER_LIST.length) { box.textContent = '暂无文件夹，请先新建一个'; return; }
  for (const g of FOLDER_LIST) {
    const row = el('div', 'fd-row');
    const inp = el('input');
    inp.type = 'text';
    inp.value = g.name;
    inp.spellcheck = false;
    const meta = el('span', 'fd-meta', g.prefixes.length + ' 个类别');
    const save = el('button', 'ghost', '保存');
    save.type = 'button';
    const del = el('button', 'ghost', '删除');
    del.type = 'button';
    const err = el('div', 'err');

    save.addEventListener('click', async () => {
      err.textContent = '';
      const want = inp.value;
      const r = await chrome.runtime.sendMessage({ type: 'folderRename', old: g.name, name: want });
      if (!r || !r.ok) { err.textContent = (r && r.msg) || '改名失败'; return; }
      await loadFolders();
      $('fdErr').className = 'err ok';
      $('fdErr').textContent = '已改名为「' + want.trim().replace(/丨/g, '｜') + '」';
    });

    del.addEventListener('click', async () => {
      if (!confirm('「' + g.name + '」将从配置中移除；书签栏里的真实目录与已存书签不会删除。继续？')) return;
      const r = await chrome.runtime.sendMessage({ type: 'folderDel', name: g.name });
      if (!r || !r.ok) { err.textContent = (r && r.msg) || '删除失败'; return; }
      await loadFolders();
      $('fdErr').className = 'err ok';
      $('fdErr').textContent = '已移除「' + g.name + '」' + (r.moved ? '，其中 ' + r.moved + ' 个类别已移到「' + r.fallback + '」' : '');
    });

    row.appendChild(inp);
    row.appendChild(meta);
    row.appendChild(save);
    row.appendChild(del);
    row.appendChild(err);
    box.appendChild(row);
  }
}

async function loadFolders() {
  const r = await chrome.runtime.sendMessage({ type: 'folders' });
  FOLDER_LIST = (r && r.folders) || [];
  if (Array.isArray(r && r.folders) && r.folders.length) {
    FOLDERS.length = 0;
    for (const g of r.folders) FOLDERS.push({ name: g.name, prefixes: (g.prefixes || []).slice() });
    rebuildPrefixMap();
  }
  const cp = $('catFolder') ? $('catFolder').value : '';
  renderFolders();
  buildFolderSelects(cp);
}

$('fdAdd').addEventListener('click', async () => {
  const err = $('fdErr');
  err.className = 'err';
  err.textContent = '';
  const r = await chrome.runtime.sendMessage({ type: 'folderAdd', name: $('fdName').value });
  if (!r || !r.ok) { err.textContent = (r && r.msg) || '新建失败'; return; }
  $('fdName').value = '';
  await loadFolders();
  err.className = 'err ok';
  err.textContent = '已新建「' + r.name + '」';
});

// ── 可视化规则编辑 ─────────────────────────
let RULES = { domain: [], keyword: [], custom: {} };
let ruleTab = 'domain';   // domain | keyword
let ruleEditing = null;   // null = 新增；否则是被编辑项的 key

const isDomainTab = () => ruleTab === 'domain';

async function loadRules() {
  const r = await chrome.runtime.sendMessage({ type: 'rulesList' });
  RULES = (r && r.ok) ? r : { domain: [], keyword: [], custom: {} };
  renderRules();
}

function prefixOptions() {
  const seen = new Set();
  const out = [];
  // FOLDER_LIST 是后台配置，没加载完时退回 rules.js 里的出厂 FOLDERS，避免下拉为空
  const groups = (FOLDER_LIST && FOLDER_LIST.length) ? FOLDER_LIST : FOLDERS;
  for (const g of groups) for (const p of g.prefixes) if (!seen.has(p)) { seen.add(p); out.push(p); }
  for (const p of Object.keys(RULES.custom || {})) if (!seen.has(p)) { seen.add(p); out.push(p); }
  return out;
}

function fillPrefixSelect() {
  const sel = $('rfPrefix');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const p of prefixOptions()) {
    const o = el('option', null, p);
    o.value = p;
    sel.appendChild(o);
  }
  if (keep && prefixOptions().includes(keep)) sel.value = keep;
}

function renderRules() {
  const list = $('ruleList');
  const q = ($('ruleSearch').value || '').trim().toLowerCase();
  const all = isDomainTab() ? RULES.domain : RULES.keyword;
  const items = q
    ? all.filter(x => isDomainTab()
        ? (x.key + ' ' + x.name + ' ' + x.kw).toLowerCase().includes(q)
        : (x.re + ' ' + x.kw + ' ' + x.prefix).toLowerCase().includes(q))
    : all;

  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  $('ruleCount').textContent = q ? '匹配 ' + items.length + ' / ' + all.length : '共 ' + all.length + ' 条';

  if (!items.length) {
    const d = el('div', 'rule-empty', q ? '没有匹配的规则' : '还没有规则，点「+ 新增规则」加一条');
    frag.appendChild(d);
    list.appendChild(frag);
    return;
  }
  // 自定义的排前面，便于查看自己加过什么
  const sorted = items.slice().sort((a, b) => (a.builtin === b.builtin) ? 0 : (a.builtin ? 1 : -1));
  for (const x of sorted) {
    const row = el('div', 'rule-item');
    const key = el('div', 'r-key', isDomainTab() ? x.key : '/' + x.re + '/');
    const val = el('div', 'r-val', isDomainTab() ? '【' + x.prefix + '】' + x.name + '｜' + x.kw : '【' + x.prefix + '】' + (x.kw || ''));
    const tag = el('span', 'r-tag' + (x.builtin ? '' : ' mine'), x.builtin ? '内置' : '我的');
    const edit = el('button', 'ghost', '改');
    const del = el('button', 'ghost', '删');
    edit.type = 'button'; del.type = 'button';
    edit.addEventListener('click', () => openRuleForm(x));
    del.addEventListener('click', () => delRule(x));
    row.appendChild(key); row.appendChild(val); row.appendChild(tag);
    row.appendChild(edit); row.appendChild(del);
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

// 规则四百多条，键入时全量重建 DOM 会顿；防抖 120ms
const renderRulesSoon = debounce(renderRules, 120);

function openRuleForm(item) {
  $('ruleErr').textContent = '';
  fillPrefixSelect();
  const f = $('ruleForm');
  if (item) {
    ruleEditing = item.key;
    if (isDomainTab()) {
      $('rfKey').value = item.key;
      $('rfKey').placeholder = '网址，如 example.com';
      $('rfName').value = item.name;
      $('rfKw').value = item.kw;
    } else {
      $('rfKey').value = item.re;
      $('rfKey').placeholder = '标题里的词，如 影视|电影';
      $('rfName').value = '';
      $('rfKw').value = item.kw;
    }
    $('rfPrefix').value = item.prefix;
    $('rfName').style.display = isDomainTab() ? '' : 'none';
  } else {
    ruleEditing = null;
    $('rfKey').value = '';
    $('rfKey').placeholder = isDomainTab() ? '网址，如 example.com' : '标题里的词，如 影视|电影';
    $('rfName').value = '';
    $('rfKw').value = '';
    $('rfName').style.display = isDomainTab() ? '' : 'none';
    // 新建时默认落在「工具」，没有就取第一个，别让下拉空着
    const opts = prefixOptions();
    if (opts.length) $('rfPrefix').value = opts.includes('工具') ? '工具' : opts[0];
  }
  f.classList.add('on');
  $('rfKey').focus();
}

function closeRuleForm() {
  $('ruleForm').classList.remove('on');
  ruleEditing = null;
  $('ruleErr').textContent = '';
}

async function saveRule() {
  const err = $('ruleErr');
  err.textContent = '';
  const key = $('rfKey').value.trim();
  const prefix = $('rfPrefix').value;
  const kw = $('rfKw').value.trim();
  let r;
  if (isDomainTab()) {
    r = await chrome.runtime.sendMessage({
      type: 'ruleDomainSet', key, oldKey: ruleEditing || '',
      prefix, name: $('rfName').value.trim(), kw
    });
  } else {
    r = await chrome.runtime.sendMessage({
      type: 'ruleKeywordSet', re: key, oldKey: ruleEditing || '', prefix, kw, flags: 'i'
    });
  }
  if (!r || !r.ok) { err.textContent = (r && r.msg) || '保存失败'; return; }
  closeRuleForm();
  await loadRules();
}

async function delRule(x) {
  const what = isDomainTab() ? x.key : '/' + x.re + '/ → ' + x.prefix;
  if (!confirm('删除规则「' + what + '」？\n\n删除后该站点改由关键词规则或 AI 判断，不会动已有书签。')) return;
  const r = await chrome.runtime.sendMessage({
    type: isDomainTab() ? 'ruleDomainDel' : 'ruleKeywordDel', key: x.key
  });
  if (!r || !r.ok) { $('ruleErr').textContent = (r && r.msg) || '删除失败'; return; }
  await loadRules();
}

function switchTab(t) {
  ruleTab = t;
  $('tabDomain').classList.toggle('on', t === 'domain');
  $('tabKeyword').classList.toggle('on', t === 'keyword');
  $('ruleSearch').placeholder = t === 'domain' ? '搜索网址或名称…' : '搜索标题里的词…';
  closeRuleForm();
  renderRules();
}

$('tabDomain').addEventListener('click', () => switchTab('domain'));
$('tabKeyword').addEventListener('click', () => switchTab('keyword'));
$('ruleSearch').addEventListener('input', renderRulesSoon);
$('ruleAdd').addEventListener('click', () => openRuleForm(null));
$('rfSave').addEventListener('click', saveRule);
$('rfCancel').addEventListener('click', closeRuleForm);
$('rfKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveRule(); });
$('rfName').addEventListener('keydown', e => { if (e.key === 'Enter') saveRule(); });
$('rfKw').addEventListener('keydown', e => { if (e.key === 'Enter') saveRule(); });

$('ruleReset').addEventListener('click', async () => {
  if (!confirm('恢复初始规则？\n\n你自己新增、修改、删除的规则都会被清掉，回到扩展自带的那套；已有书签不受影响。')) return;
  const r = await chrome.runtime.sendMessage({ type: 'rulesRestore' });
  showOut('impOut', (r && r.msg) || '已恢复初始规则');
  await loadRules();
});

// ── AI 连通性测试 ──────────────────────────
// 用表单里当前填的值测，不要求先「保存设置」，方便边填边试
$('aiTest').addEventListener('click', async () => {
  const btn = $('aiTest');
  const out = $('aiOut');
  btn.disabled = true;
  btn.textContent = '测试中…';
  out.style.display = 'block';
  out.textContent = '正在请求…（首次会弹窗请求该网址的访问权限，请点允许）';
  let r;
  try {
    r = await chrome.runtime.sendMessage({
      type: 'aiTest',
      overrides: {
        aibase: $('aibase').value.trim(),
        aimodel: $('aimodel').value.trim(),
        apikey: $('apikey').value.trim()
      }
    });
  } catch (e) {
    r = { ok: false, err: '消息通道异常：' + ((e && e.message) || e) };
  }
  btn.disabled = false;
  btn.textContent = '测试连接';
  if (r && r.ok) {
    out.textContent = '用起来没问题 ✅\n它会把页面归成：' + r.result.title +
      '\n（类别 ' + r.result.prefix + ' / 名称 ' + r.result.name + ' / 用途 ' + r.result.kw + '）';
  } else {
    out.textContent = '没连上 ❌\n' + ((r && r.err) || '未知原因') +
      '\n\n按顺序检查：1) 服务地址结尾有没有 /v1　2) 密钥对不对　3) 这家服务是否允许浏览器扩展访问。' +
      '若提示「Failed to fetch」，多半是被对方拦了。';
  }
});

load();
loadFolders().then(() => { loadRules(); loadCats(); });
