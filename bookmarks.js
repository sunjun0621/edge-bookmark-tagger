// bookmarks.js —— 书签与一级文件夹的所有读写原语
// 依赖 rules.js（CONST / FOLDERS / PREFIX_FOLDER / CUSTOM_PREFIX / OLD_FOLDER_NAMES / rebuildPrefixMap / validateFolderName）

// 兜底文件夹：优先「其他｜归档」，被删了就用第一个
function defaultFolderName() {
  const hit = FOLDERS.find(f => f.name === CONST.FALLBACK_FOLDER);
  if (hit) return hit.name;
  return FOLDERS.length ? FOLDERS[0].name : '';
}

// 用配置覆盖运行时 FOLDERS（原地改，保持数组引用，popup/options 直读）
function applyFolders(list) {
  if (!Array.isArray(list) || !list.length) return;
  FOLDERS.length = 0;
  for (const f of list) FOLDERS.push({ name: f.name, prefixes: (f.prefixes || []).slice() });
}

async function saveFolders() {
  await chrome.storage.local.set({
    folders: FOLDERS.map(f => ({ name: f.name, prefixes: f.prefixes.slice() }))
  });
}

async function saveCustoms() {
  await chrome.storage.local.set({ customPrefix: CUSTOM_PREFIX });
}

// 书签栏 id：取根节点下的第一个子节点；取不到再按标题匹配
async function barId() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const root = tree && tree[0];
    const kids = (root && root.children) || [];
    const byId = kids.find(n => n.id === '1');
    if (byId) return byId.id;
    const byTitle = kids.find(n => /收藏夹栏|书签栏|bookmarks?\s*bar/i.test(n.title || ''));
    if (byTitle) return byTitle.id;
    if (kids.length) return kids[0].id;
  } catch (e) { console.warn('取书签栏 id 失败', e); }
  return '1';
}

// 书签树里是否已有同名目录（防止重复创建真实文件夹）
async function folderTitleExists(title) {
  try {
    const tree = await chrome.bookmarks.getTree();
    let hit = false;
    (function walk(nodes) {
      for (const n of nodes) {
        if (hit) return;
        if (!n.url && n.title === title) { hit = true; return; }
        if (n.children) walk(n.children);
      }
    })(tree);
    return hit;
  } catch (e) { return false; }
}

let folderCache = { at: 0, map: {} };
// 已有现成书签树时直接用，省一次全树读取（启动路径上树要读两遍，合并成一遍）
function mapFolderIdsFromTree(tree) {
  const map = {};
  const names = FOLDERS.map(f => f.name);
  (function walk(nodes) {
    for (const n of nodes) {
      if (!n.url && names.includes(n.title)) map[n.title] = n.id;
      if (n.children) walk(n.children);
    }
  })(tree);
  return map;
}

async function folderIds(force) {
  if (!force && Date.now() - folderCache.at < 60000 && Object.keys(folderCache.map).length) return folderCache.map;
  const tree = await chrome.bookmarks.getTree();
  const map = mapFolderIdsFromTree(tree);
  folderCache = { at: Date.now(), map };
  return map;
}

// 幂等迁移：真实文件夹名「丨」→「｜」。检测不到旧名就跳过，不用 storage 标记位
// tree 参数可选：启动路径上由调用方传入，避免再读一遍全树
async function migrateFolderNames(tree) {
  const exist = {};
  try {
    tree = tree || await chrome.bookmarks.getTree();
    (function walk(nodes) {
      for (const n of nodes) {
        // 目录自身有 children，不能靠 else 分支判断，必须先收自己再下钻
        if (!n.url && n.title) (exist[n.title] = exist[n.title] || []).push(n.id);
        if (n.children) walk(n.children);
      }
    })(tree);
  } catch (e) { console.warn('[迁移] 读取书签树失败', e); return; }

  // 1) 先改真实文件夹
  const renamed = {};   // 本次真实改了名的（用于日志与提示）
  const mapped = {};    // 名字映射（含「此前已迁移过」的情形，仅用于刷配置残留）
  for (const oldName in OLD_FOLDER_NAMES) {
    const newName = OLD_FOLDER_NAMES[oldName];
    const olds = exist[oldName] || [];
    const news = exist[newName] || [];
    if (!olds.length) {
      // 旧名不在：已迁移过（或用户自己改成了别的名字），只做配置对齐，不提示
      if (news.length) mapped[oldName] = newName;
      continue;
    }
    if (news.length) { console.log('[迁移] 已存在「' + newName + '」，跳过「' + oldName + '」'); continue; }
    try {
      await chrome.bookmarks.update(olds[0], { title: newName });
      renamed[oldName] = newName;
      mapped[oldName] = newName;
    } catch (e) { console.warn('[迁移] 改名失败「' + oldName + '」', e); }
  }

  // 2) 再刷配置里的旧名：自定义前缀的值 + 文件夹配置
  let cpTouched = false;
  let fdTouched = false;
  const cp = Object.assign({}, CUSTOM_PREFIX);
  for (const k in cp) {
    const nv = mapped[cp[k]];
    if (nv) { CUSTOM_PREFIX[k] = nv; cpTouched = true; }
  }
  for (const f of FOLDERS) {
    const nv = mapped[f.name];
    if (nv) { f.name = nv; fdTouched = true; }
  }
  if (cpTouched) await saveCustoms();
  if (fdTouched) await saveFolders();

  // 3) 重建前缀映射  4) 清文件夹缓存
  rebuildPrefixMap();
  folderCache.at = 0;

  const done = Object.keys(renamed);
  if (done.length) {
    console.log('[迁移] 文件夹名已统一为「｜」：' + done.map(o => o + ' → ' + renamed[o]).join('；'));
    try { await chrome.storage.local.set({ sepNotice: Date.now() }); } catch (e) {}
  }
}

async function findDuplicate(url, selfId) {
  if (!url) return null;
  const list = await chrome.bookmarks.search({ url });
  const same = list.filter(n => n.url === url && n.id !== selfId);
  return same.length ? same[0] : null;
}

// node 可选：调用方手里已有书签节点时（如 onCreated 事件）直接传入，省一次 get 往返
async function moveToFolder(nodeId, prefix, folderOverride, node) {
  const folderName = prefix
    ? (folderOverride || PREFIX_FOLDER[prefix] || CUSTOM_PREFIX[prefix] || defaultFolderName())
    : null;
  if (!folderName) return null;
  const ids = await folderIds();
  const target = ids[folderName];
  if (!target) return null;
  if (!node) { [node] = await chrome.bookmarks.get(nodeId); }
  if (node.parentId !== target) {
    try { await chrome.bookmarks.move(nodeId, { parentId: target, index: 0 }); } catch (e) { console.warn(e); }
  }
  return folderName;
}

// ── 一级文件夹管理（供 router 调用，统一返回 { ok, msg? }）────────────

// 配置里有、书签栏里没有的目录，批量重建
async function ensureFolders() {
  const ids = await folderIds(true);
  const miss = FOLDERS.map(f => f.name).filter(n => !ids[n]);
  if (!miss.length) return { ok: true, created: [], failed: [] };
  const bar = await barId();
  const created = [], failed = [];
  for (const n of miss) {
    try {
      await chrome.bookmarks.create({ parentId: bar, title: n });
      created.push(n);
    } catch (e) {
      failed.push(n + '：' + ((e && e.message) || e));
    }
  }
  folderCache.at = 0;
  return { ok: !failed.length, created, failed };
}

async function addFolder(rawName) {
  const v = validateFolderName(rawName, FOLDERS.map(f => f.name));
  if (!v.ok) return { ok: false, msg: v.msg };
  if (await folderTitleExists(v.name)) {
    return { ok: false, msg: '书签栏已有同名目录「' + v.name + '」，请先在浏览器里改名或删除' };
  }
  try {
    await chrome.bookmarks.create({ parentId: await barId(), title: v.name });
  } catch (e) {
    return { ok: false, msg: '创建书签目录失败：' + ((e && e.message) || e) };
  }
  FOLDERS.push({ name: v.name, prefixes: [] });
  await saveFolders();
  rebuildPrefixMap();
  folderCache.at = 0;
  return { ok: true, folders: FOLDERS, name: v.name };
}

async function renameFolder(oldName, rawName) {
  oldName = String(oldName || '').trim();
  const f = FOLDERS.find(x => x.name === oldName);
  if (!f) return { ok: false, msg: '找不到该文件夹' };
  const v = validateFolderName(rawName, FOLDERS.filter(x => x.name !== oldName).map(x => x.name));
  if (!v.ok) return { ok: false, msg: v.msg };
  if (v.name === oldName) return { ok: true, folders: FOLDERS, renamed: false };
  let realRenamed = false;
  const ids = await folderIds(true);
  const fid = ids[oldName];
  if (fid) {
    try {
      await chrome.bookmarks.update(fid, { title: v.name });
      realRenamed = true;
    } catch (e) {
      return { ok: false, msg: '改真实书签目录名失败：' + ((e && e.message) || e) };
    }
  }
  f.name = v.name;
  for (const k in CUSTOM_PREFIX) if (CUSTOM_PREFIX[k] === oldName) CUSTOM_PREFIX[k] = v.name;
  await saveCustoms();
  await saveFolders();
  rebuildPrefixMap();
  folderCache.at = 0;
  return { ok: true, folders: FOLDERS, renamed: realRenamed };
}

// 只从配置移除，不动真实书签目录；前缀迁到兜底文件夹
async function removeFolder(name) {
  name = String(name || '').trim();
  const i = FOLDERS.findIndex(x => x.name === name);
  if (i < 0) return { ok: false, msg: '找不到该文件夹' };
  const moved = FOLDERS[i].prefixes.slice();
  const fallback = name === defaultFolderName()
    ? (FOLDERS.find(f => f.name !== name) || {}).name
    : defaultFolderName();
  FOLDERS.splice(i, 1);
  if (moved.length && fallback) {
    const tf = FOLDERS.find(f => f.name === fallback);
    if (tf) for (const p of moved) if (!tf.prefixes.includes(p)) tf.prefixes.push(p);
    for (const k in CUSTOM_PREFIX) if (CUSTOM_PREFIX[k] === name) CUSTOM_PREFIX[k] = fallback;
    await saveCustoms();
  }
  await saveFolders();
  rebuildPrefixMap();
  folderCache.at = 0;
  return { ok: true, folders: FOLDERS, moved: moved.length, fallback: fallback || '' };
}

async function rebindPrefix(prefix, target) {
  prefix = String(prefix || '').trim();
  target = String(target || '').trim();
  const tf = FOLDERS.find(x => x.name === target);
  if (!prefix || !tf) return { ok: false, msg: '前缀或目标文件夹为空' };
  // 自己加的类别只改 CUSTOM_PREFIX：一旦并进 FOLDERS 就会被当成自带的，从此删不掉
  if (CUSTOM_PREFIX[prefix] && !PREFIX_FOLDER[prefix]) {
    CUSTOM_PREFIX[prefix] = target;
    await saveCustoms();
    rebuildPrefixMap();
    folderCache.at = 0;
    return { ok: true, folders: FOLDERS, customs: CUSTOM_PREFIX, folder: target };
  }
  for (const f of FOLDERS) f.prefixes = f.prefixes.filter(p => p !== prefix);
  if (!tf.prefixes.includes(prefix)) tf.prefixes.push(prefix);
  if (CUSTOM_PREFIX[prefix]) { delete CUSTOM_PREFIX[prefix]; await saveCustoms(); }
  await saveFolders();
  rebuildPrefixMap();
  folderCache.at = 0;
  return { ok: true, folders: FOLDERS, customs: CUSTOM_PREFIX, folder: target };
}
