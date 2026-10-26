// router.js —— 启动流程、消息路由、书签事件监听（组装层，不含具体实现）
// 依赖 rules.js / bookmarks.js / classify.js

const DEFAULT_CFG = {
  enabled: true,
  useai: true,
  aibase: 'https://api.deepseek.com/v1',
  aimodel: 'deepseek-chat',
  apikey: '',
  unknown: CONST.UNKNOWN_PREFIX,
  dedupe: true
};

// 只取需要的键：get(null) 会把几十 KB 的规则补丁也拖出来，而大部分消息用不到
const CFG_KEYS = ['enabled', 'useai', 'aibase', 'aimodel', 'apikey', 'unknown', 'dedupe'];

async function cfg() {
  const s = await chrome.storage.local.get(CFG_KEYS);
  return Object.assign({}, DEFAULT_CFG, s);
}

// 规则补丁的读写（设置页的可视化编辑都走这两个函数）
async function getPatch() {
  const s = await chrome.storage.local.get('rulesPatch');
  const p = s.rulesPatch || {};
  return {
    domainRules: p.domainRules || {},
    keywordRules: (p.keywordRules || []).slice(),
    domainRemove: (p.domainRemove || []).slice(),
    keywordRemove: (p.keywordRemove || []).slice()
  };
}

// 落盘并立即应用到内存（不用重新加载扩展就能看到效果）
async function savePatch(p) {
  p.domainRemove = Array.from(new Set(p.domainRemove));
  p.keywordRemove = Array.from(new Set(p.keywordRemove));
  await chrome.storage.local.set({ rulesPatch: p });
  applyRulesPatch(p);
  return p;
}

// 启动：载入自定义前缀 / 文件夹配置 / 规则补丁 → 迁移旧文件夹名
// 书签树只读一次：迁移与文件夹缓存共用，冷启动少一趟全树遍历
let ready = (async () => {
  try {
    const s = await chrome.storage.local.get(['customPrefix', 'folders', 'rulesPatch']);
    Object.assign(CUSTOM_PREFIX, s.customPrefix || {});
    if (Array.isArray(s.folders) && s.folders.length) applyFolders(s.folders);
    else await saveFolders();          // 首次：把出厂四个文件夹落盘
    rebuildPrefixMap();
    if (s.rulesPatch) applyRulesPatch(s.rulesPatch);
    const tree = await chrome.bookmarks.getTree();
    folderCache = { at: Date.now(), map: mapFolderIdsFromTree(tree) };
    await migrateFolderNames(tree);
  } catch (e) { console.warn('初始化失败', e); }
})();

// 判定 + 去重 + 改名 + 移动（Ctrl+D 走这条）
async function applyTo(nodeId, url, title, c, node) {
  c = c || (await cfg());
  let r = await classify(title, url, c);

  if (c.dedupe) {
    const dup = await findDuplicate(url, nodeId);
    if (dup) {
      r = { prefix: CONST.DUP_PREFIX, name: r.name || cleanName(title), kw: CONST.DUP_KW, source: '重复检测' };
    }
  }

  const newTitle = titleOf(r);
  if (newTitle && newTitle !== title) {
    try { await chrome.bookmarks.update(nodeId, { title: newTitle }); } catch (e) { console.warn(e); }
  }

  const folderName = await moveToFolder(nodeId, r.prefix, null, node);
  return { title: newTitle, folder: folderName, source: r.source };
}

// 手动保存（面板点「保存并整理」走这条）
async function applyFromPanel(msg) {
  const r = { prefix: msg.prefix, name: msg.name, kw: msg.kw, source: 'popup' };
  const newTitle = titleOf(r);
  const dup = await findDuplicate(msg.url, null);
  let id = dup ? dup.id : null;

  if (id) {
    try {
      await chrome.bookmarks.update(id, { title: newTitle });
    } catch (e) {
      return { ok: false, msg: '更新已有书签失败：' + ((e && e.message) || e) };
    }
  } else {
    try {
      const created = await chrome.bookmarks.create({ parentId: await barId(), title: newTitle, url: msg.url });
      id = created.id;
    } catch (e) {
      return { ok: false, msg: '创建书签失败：' + ((e && e.message) || e) };
    }
  }

  // 自定义前缀：记住它归到哪个文件夹，下次自动套用
  let folder = msg.folder || null;
  if (msg.prefix && !PREFIX_FOLDER[msg.prefix] && folder) {
    CUSTOM_PREFIX[msg.prefix] = folder;
    await saveCustoms();
  }
  folder = await moveToFolder(id, msg.prefix, msg.folder);
  return { ok: true, id, title: newTitle, folder, custom: !!CUSTOM_PREFIX[msg.prefix] };
}

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  await ready;
  if (!node || !node.url) return;
  if (!/^https?:/i.test(node.url)) return;
  if (isFormatted(node.title || '')) return;
  const c = await cfg();
  if (!c.enabled) return;
  try { await applyTo(id, node.url, node.title, c, node); } catch (e) { console.warn('applyTo 失败', e); }
});

// 文件夹被增删改后刷新缓存
['onRemoved', 'onChanged'].forEach(ev => {
  try { chrome.bookmarks[ev].addListener(() => { folderCache.at = 0; }); } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    // 配置只在真正需要的消息里才读（十几类消息根本用不到，全量读一次得不偿失）
    const needCfg = ['preview', 'suggest', 'apply', 'aiTest'].includes(msg.type);
    const c = needCfg ? await cfg() : null;
    switch (msg.type) {
      case 'preview': {
        const r = await classify(msg.title, msg.url, c);
        sendResponse({ ok: true, prefix: r.prefix, name: r.name, kw: r.kw, source: r.source, title: titleOf(r) });
        return;
      }
      // 面板「AI 填入」：跳过规则，直接让 AI 推荐前缀/名称/关键词/文件夹
      case 'suggest': {
        const r2 = await aiCall(msg.title, msg.url, c, true, true);
        if (!r2.r) { sendResponse({ ok: false, err: r2.err }); return; }
        const s = r2.r;
        sendResponse({
          ok: true,
          prefix: s.prefix,
          name: s.name,
          kw: s.kw,
          folder: s.folder || PREFIX_FOLDER[s.prefix] || CUSTOM_PREFIX[s.prefix] || '',
          source: s.source,
          title: titleOf(s)
        });
        return;
      }
      case 'apply':
        sendResponse(await applyFromPanel(msg));
        return;
      case 'customs':
        sendResponse({ ok: true, customs: CUSTOM_PREFIX, folders: FOLDERS });
        return;

      // ── 类别总览与增删改移（设置页「自己的类别」用）──────
      // 一次性给出全部类别：内置的 + 自己加的，带所属文件夹与是否在用
      case 'catList': {
        const used = {};
        for (const k in DOMAIN_RULES) used[DOMAIN_RULES[k][0]] = (used[DOMAIN_RULES[k][0]] || 0) + 1;
        for (const r of KEYWORD_RULES) used[r.prefix] = (used[r.prefix] || 0) + 1;
        const items = [];
        const seen = new Set();
        for (const f of FOLDERS) {
          for (const p of f.prefixes) {
            if (seen.has(p)) continue;
            seen.add(p);
            items.push({ name: p, folder: f.name, builtin: true, rules: used[p] || 0 });
          }
        }
        for (const p in CUSTOM_PREFIX) {
          if (seen.has(p)) continue;
          seen.add(p);
          items.push({ name: p, folder: CUSTOM_PREFIX[p], builtin: false, rules: used[p] || 0 });
        }
        sendResponse({ ok: true, items, folders: FOLDERS.map(f => f.name) });
        return;
      }
      // 新增类别并指定放进哪个文件夹（已存在则直接改文件夹）
      case 'catAdd': {
        const pfx = String(msg.name || '').trim();
        const folder = String(msg.folder || '').trim();
        if (!pfx) { sendResponse({ ok: false, msg: '类别名不能为空' }); return; }
        if (pfx.length > 14) { sendResponse({ ok: false, msg: '类别名最多 14 个字' }); return; }
        if (/[丨｜【】]/.test(pfx)) { sendResponse({ ok: false, msg: '类别名不能含「｜」「【】」' }); return; }
        if (!FOLDERS.some(f => f.name === folder)) { sendResponse({ ok: false, msg: '请选择要放进哪个文件夹' }); return; }
        if (PREFIX_FOLDER[pfx]) { sendResponse({ ok: false, msg: '「' + pfx + '」是自带的类别，请用下面的「移动」改位置' }); return; }
        CUSTOM_PREFIX[pfx] = folder;
        await saveCustoms();
        sendResponse({ ok: true, name: pfx, folder });
        return;
      }
      // 删除类别（只从配置移除，不动已有书签）
      case 'catDel': {
        const pfx = String(msg.name || '').trim();
        if (PREFIX_FOLDER[pfx]) { sendResponse({ ok: false, msg: '「' + pfx + '」是自带的类别，不能删除。它的规则可以在「自动归类规则」里删。' }); return; }
        if (!(pfx in CUSTOM_PREFIX)) { sendResponse({ ok: false, msg: '找不到这个类别' }); return; }
        delete CUSTOM_PREFIX[pfx];
        await saveCustoms();
        sendResponse({ ok: true, name: pfx });
        return;
      }
      // 把类别移到另一个文件夹（内置的会改文件夹配置，自己加的改映射）
      case 'catMove': {
        const pfx = String(msg.name || '').trim();
        const folder = String(msg.folder || '').trim();
        if (!FOLDERS.some(f => f.name === folder)) { sendResponse({ ok: false, msg: '目标文件夹不存在' }); return; }
        const r = await rebindPrefix(pfx, folder);
        if (!r.ok) { sendResponse(r); return; }
        sendResponse({ ok: true, name: pfx, folder });
        return;
      }
      // 用途（关键词）清单：从历史与规则里汇总，供设置页查看和管理
      case 'kwList': {
        const used = {};
        for (const k in DOMAIN_RULES) {
          const kw = DOMAIN_RULES[k][2];
          if (kw) used[kw] = (used[kw] || 0) + 1;
        }
        for (const r of KEYWORD_RULES) if (r.kw) used[r.kw] = (used[r.kw] || 0) + 1;
        const recentKw = (await chrome.storage.local.get('recentKeyword')).recentKeyword || [];
        const items = Object.keys(used).map(k => ({ name: k, count: used[k], recent: recentKw.indexOf(k) >= 0 }))
          .sort((a, b) => b.count - a.count);
        sendResponse({ ok: true, items });
        return;
      }
      case 'customSet': {
        const pfx = String(msg.prefix || '').trim();
        const folder = String(msg.folder || '').trim();
        if (pfx && folder && !PREFIX_FOLDER[pfx]) {
          CUSTOM_PREFIX[pfx] = folder;
          await saveCustoms();
        }
        sendResponse({ ok: true, customs: CUSTOM_PREFIX });
        return;
      }
      case 'customDel':
        delete CUSTOM_PREFIX[String(msg.prefix || '').trim()];
        await saveCustoms();
        sendResponse({ ok: true, customs: CUSTOM_PREFIX });
        return;
      case 'folders':
        sendResponse({ ok: true, folders: FOLDERS, ids: await folderIds(true), customs: CUSTOM_PREFIX });
        return;

      // ── 一级文件夹管理 ──────────────────────────
      case 'folderEnsure':
        sendResponse(await ensureFolders());
        return;
      case 'folderAdd':
        sendResponse(await addFolder(msg.name));
        return;
      case 'folderRename':
        sendResponse(await renameFolder(msg.old, msg.name));
        return;
      case 'folderDel':
        sendResponse(await removeFolder(msg.name));
        return;
      case 'folderRebind':
        sendResponse(await rebindPrefix(msg.prefix, msg.folder));
        return;

      // ── 规则导入导出 ────────────────────────────
      case 'rulesExport':
        sendResponse({ ok: true, data: exportRules() });
        return;
      case 'rulesImport': {
        const patch = msg.patch || {};
        const s = await chrome.storage.local.get('rulesPatch');
        const old = s.rulesPatch || {};
        const merged = {
          domainRules: Object.assign({}, old.domainRules || {}, patch.domainRules || {}),
          keywordRules: (old.keywordRules || []).concat(patch.keywordRules || []),
          domainRemove: Array.from(new Set((old.domainRemove || []).concat(patch.domainRemove || []))),
          keywordRemove: Array.from(new Set((old.keywordRemove || []).concat(patch.keywordRemove || [])))
        };
        // 重新加回来的规则从删除表里摘掉
        merged.domainRemove = merged.domainRemove.filter(d => !merged.domainRules[d]);
        const keepKw = new Set(merged.keywordRules.map(r => (r && r.re) + '\u0000' + (r && r.prefix)));
        merged.keywordRemove = merged.keywordRemove.filter(k => !keepKw.has(k));
        const seen = new Set();
        merged.keywordRules = merged.keywordRules.filter(r => {
          const k = (r && r.re) + '\u0000' + (r && r.prefix);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        await chrome.storage.local.set({ rulesPatch: merged });
        const n = applyRulesPatch(merged);
        sendResponse({
          ok: true,
          domain: n.domain,
          keyword: n.keyword,
          total: { domain: Object.keys(DOMAIN_RULES).length, keyword: KEYWORD_RULES.length }
        });
        return;
      }

      // ── 可视化规则编辑（设置页用）────────────────
      case 'rulesList': {
        sendResponse({
          ok: true,
          domain: Object.keys(DOMAIN_RULES).map(k => ({ key: k, prefix: DOMAIN_RULES[k][0], name: DOMAIN_RULES[k][1], kw: DOMAIN_RULES[k][2], builtin: RULES_META.builtinDomains.indexOf(k) >= 0 })),
          keyword: KEYWORD_RULES.map(r => {
            const key = r.re.source + '\u0000' + r.prefix;
            return { key, re: r.re.source, flags: r.re.flags, prefix: r.prefix, kw: r.kw || '', builtin: RULES_META.builtinKeywords.indexOf(key) >= 0 };
          }),
          custom: Object.assign({}, CUSTOM_PREFIX)
        });
        return;
      }
      case 'ruleDomainSet': {
        const k = String(msg.key || '').trim().toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(k)) { sendResponse({ ok: false, msg: '网址格式不对，示例：example.com 或 sub.example.com' }); return; }
        if (!PREFIX_FOLDER[msg.prefix] && !CUSTOM_PREFIX[msg.prefix]) { sendResponse({ ok: false, msg: '类别「' + msg.prefix + '」还没分到文件夹，请先到「文件夹」里设置' }); return; }
        const name = String(msg.name || '').trim();
        if (!name) { sendResponse({ ok: false, msg: '名称不能为空' }); return; }
        const patch = await getPatch();
        // 改域名 = 删旧键 + 加新键。旧键若来自补丁须从 domainRules 里摘掉，
        // 否则重建时会被重新加回来；旧键若是内置的则记进 domainRemove 停用
        const old = String(msg.oldKey || '').trim().toLowerCase();
        if (old && old !== k) {
          delete patch.domainRules[old];
          if (RULES_META.builtinDomains.indexOf(old) >= 0 && patch.domainRemove.indexOf(old) < 0) patch.domainRemove.push(old);
        }
        patch.domainRemove = patch.domainRemove.filter(x => x !== k);
        patch.domainRules[k] = [msg.prefix, name.slice(0, CONST.NAME_MAX), String(msg.kw || '').trim().slice(0, CONST.KW_MAX) || CONST.KW_DEFAULT];
        await savePatch(patch);
        sendResponse({ ok: true });
        return;
      }
      case 'ruleDomainDel': {
        const k = String(msg.key || '').trim();
        const patch = await getPatch();
        delete patch.domainRules[k];
        if (RULES_META.builtinDomains.indexOf(k) >= 0 && patch.domainRemove.indexOf(k) < 0) patch.domainRemove.push(k);
        await savePatch(patch);
        sendResponse({ ok: true });
        return;
      }
      case 'ruleKeywordSet': {
        const re = String(msg.re || '').trim();
        if (!re) { sendResponse({ ok: false, msg: '匹配词不能为空' }); return; }
        try { new RegExp(re, msg.flags || 'i'); } catch (e) { sendResponse({ ok: false, msg: '匹配规则写法有误：' + e.message }); return; }
        if (!PREFIX_FOLDER[msg.prefix] && !CUSTOM_PREFIX[msg.prefix]) { sendResponse({ ok: false, msg: '类别「' + msg.prefix + '」还没分到文件夹' }); return; }
        const patch = await getPatch();
        const oldKey = String(msg.oldKey || '');
        const item = { re, flags: msg.flags || 'i', prefix: msg.prefix, kw: String(msg.kw || '').trim().slice(0, CONST.KW_MAX) };
        // 从「已删除」里恢复同名规则时先摘掉删除标记
        const newKey = re + '\u0000' + item.prefix;
        patch.keywordRemove = patch.keywordRemove.filter(x => x !== newKey);
        if (oldKey && oldKey !== newKey) {
          patch.keywordRules = patch.keywordRules.filter(r => (r.re + '\u0000' + r.prefix) !== oldKey);
          if (RULES_META.builtinKeywords.indexOf(oldKey) >= 0) patch.keywordRemove.push(oldKey);
        }
        patch.keywordRules = patch.keywordRules.filter(r => (r.re + '\u0000' + r.prefix) !== newKey);
        patch.keywordRules.push(item);
        await savePatch(patch);
        sendResponse({ ok: true });
        return;
      }
      case 'ruleKeywordDel': {
        const key = String(msg.key || '');
        const patch = await getPatch();
        patch.keywordRules = patch.keywordRules.filter(r => (r.re + '\u0000' + r.prefix) !== key);
        if (RULES_META.builtinKeywords.indexOf(key) >= 0 && patch.keywordRemove.indexOf(key) < 0) patch.keywordRemove.push(key);
        await savePatch(patch);
        sendResponse({ ok: true });
        return;
      }
      case 'rulesRestore': {
        // 清空所有自定义增删，回到出厂规则（内存也立刻还原）
        await chrome.storage.local.remove('rulesPatch');
        applyRulesPatch(null);
        sendResponse({ ok: true, msg: '已恢复初始规则，共 ' + Object.keys(DOMAIN_RULES).length + ' 条网址规则' });
        return;
      }

      // ── AI 连通性测试 ───────────────────────────
      case 'aiTest': {
        const c2 = Object.assign({}, c);
        if (msg.overrides) Object.assign(c2, msg.overrides);
        c2.useai = true;
        const r = await aiCall(msg.title || '某短剧网 - 免费在线观看最新短剧',
          msg.url || 'https://example-duanju.com/play/123', c2, true);
        sendResponse({
          ok: !!r.r,
          err: r.err,
          result: r.r ? { prefix: r.r.prefix, name: r.r.name, kw: r.r.kw, title: titleOf(r.r) } : null
        });
        return;
      }

      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});
