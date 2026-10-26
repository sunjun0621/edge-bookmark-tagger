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
  if (!items.length) {
    const d = el('div', 'cat-empty',
      q ? '没有匹配的类别' : (onlyMine ? '你还没有自己加过类别' : '还没有类别'));
    box.appendChild(d);
    return;
  }
  // 自己加的排前面，方便查看管理
  const sorted = items.slice().sort((a, b) => (a.builtin === b.builtin) ? 0 : (a.builtin ? 1 : -1));
  for (const x of sorted) {
    const row = el('div', 'cat-item');

    const name = el('span', 'c-name', x.name);
    const tag = el('span', 'c-tag' + (x.builtin ? '' : ' mine'), x.builtin ? '自带' : '我的');

    // 文件夹选择：改完立即生效，等于「移动」
    const sel = el('select', 'c-sel');
    for (const f of FOLDER_LIST) {
      const o = el('option', null, f.name);
      o.value = f.name;
      sel.appendChild(o);
    }
    sel.value = x.folder;
    sel.title = '放进哪个文件夹';
    sel.addEventListener('change', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'catMove', name: x.name, folder: sel.value });
      if (!r || !r.ok) { $('catErr').textContent = (r && r.msg) || '移动失败'; sel.value = x.folder; return; }
      $('catErr').className = 'err ok';
      $('catErr').textContent = '「' + x.name + '」已移到「' + sel.value + '」';
      await loadCats();
      await loadFolders();
    });

    const rules = el('span', 'c-rules', x.rules ? x.rules + ' 条规则' : '');

    row.appendChild(name);
    row.appendChild(tag);
    row.appendChild(sel);
    row.appendChild(rules);

    if (!x.builtin) {
      const del = el('button', 'ghost', '删');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('删除类别「' + x.name + '」？\n\n以后不会再归到这个类别，已有书签不受影响。')) return;
        const r = await chrome.runtime.sendMessage({ type: 'catDel', name: x.name });
        if (!r || !r.ok) { $('catErr').textContent = (r && r.msg) || '删除失败'; return; }
        $('catErr').className = 'err ok';
        $('catErr').textContent = '已删除「' + x.name + '」';
        await loadCats();
        await loadFolders();
      });
      row.appendChild(del);
    }
    box.appendChild(row);
  }
}

$('catSearch').addEventListener('input', renderCats);
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
  $('ruleCount').textContent = q ? '匹配 ' + items.length + ' / ' + all.length : '共 ' + all.length + ' 条';

  if (!items.length) {
    const d = el('div', 'rule-empty', q ? '没有匹配的规则' : '还没有规则，点「+ 新增规则」加一条');
    list.appendChild(d);
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
    list.appendChild(row);
  }
}

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
$('ruleSearch').addEventListener('input', renderRules);
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
