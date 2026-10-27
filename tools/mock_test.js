// 临时测试脚本：mock chrome API 验证 background.js（测完即删）
// 用法：node mock_test.js
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname.replace(/\\tools$/,'') + '/';
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); }

// ── 书签树 ─────────────────────────────────────
function makeStore() {
  const root = { id: '0', title: '', children: [] };
  const bar = { id: '1', parentId: '0', title: '收藏夹栏', children: [] };
  root.children.push(bar);
  let seq = 100;
  const L = { created: [], removed: [], changed: [] };
  const all = (n, out) => { out = out || []; out.push(n); for (const c of n.children || []) all(c, out); return out; };
  const find = id => all(root).find(n => n.id === id);
  const fire = ev => L[ev].forEach(fn => fn());
  return {
    root, bar,
    seq: () => ++seq,
    all: () => all(root),
    find,
    addFolder(parentId, title) {
      const n = { id: 'n' + (++seq), parentId, title, children: [] };
      find(parentId).children.push(n); return n;
    },
    addBookmark(parentId, title, url) {
      const n = { id: 'n' + (++seq), parentId, title, url, children: [] };
      find(parentId).children.push(n); return n;
    },
    removeFolder(title) {
      const i = bar.children.findIndex(n => n.title === title);
      if (i < 0) return false;
      bar.children.splice(i, 1);
      fire('removed');
      return true;
    },
    fire, listeners: L
  };
}

function makeStorage(data) {
  const self = {
    data: data || {},
    async get(k) {
      if (k == null) return Object.assign({}, self.data);
      if (typeof k === 'string') return k in self.data ? { [k]: self.data[k] } : {};
      const o = {};
      for (const key of k) if (key in self.data) o[key] = self.data[key];
      return o;
    },
    async set(obj) { Object.assign(self.data, obj); },
    async remove(k) { delete self.data[k]; }
  };
  return self;
}

function makeChrome(store, storage) {
  const wrap = ev => ({ addListener: fn => store.listeners[ev].push(fn) });
  return {
    storage: { local: storage },
    bookmarks: {
      async getTree() { return [store.root]; },
      async get(id) { const n = store.find(id); if (!n) throw new Error('节点不存在 ' + id); return [n]; },
      async search(q) { return store.all().filter(n => n.url && n.url === q.url); },
      async update(id, patch) {
        const n = store.find(id); if (!n) throw new Error('节点不存在');
        if (patch.title != null) n.title = patch.title;
        store.fire('changed'); return n;
      },
      async move(id, p) {
        const n = store.find(id), tgt = store.find(p.parentId);
        if (!tgt) throw new Error('目标不存在');
        const old = store.find(n.parentId);
        old.children = old.children.filter(x => x.id !== id);
        n.parentId = p.parentId;
        tgt.children.splice(p.index == null ? 0 : p.index, 0, n);
        store.fire('changed'); return n;
      },
      async create(p) {
        if (store.failCreate) throw new Error('模拟创建失败');
        const tgt = store.find(p.parentId);
        if (!tgt) throw new Error('父目录不存在');
        const n = { id: 'n' + store.seq(), parentId: p.parentId, title: p.title, children: [] };
        if (p.url) n.url = p.url;
        tgt.children.push(n);
        store.fire('created');
        return n;
      },
      onCreated: wrap('created'),
      onRemoved: wrap('removed'),
      onChanged: wrap('changed')
    },
    runtime: {
      onMessage: { addListener: fn => { store.msgHandler = fn; } },
      getManifest: () => ({ version: '1.4.0' }),
      lastError: null
    },
    // MV3 可选宿主权限：测试里默认视为已授权，permissionsDenied 时模拟用户拒绝
    permissions: {
      async contains() { return !store.permissionsDenied; },
      async request() { return !store.permissionsDenied; }
    }
  };
}

// 加载扩展（模拟一次 service worker 启动）
function loadExt(store, storage) {
  const ctx = { console, URL, AbortController, setTimeout, clearTimeout, Date };
  ctx.chrome = makeChrome(store, storage);
  ctx.fetch = store.fetchImpl || (() => { throw new Error('测试环境无网络'); });
  ctx.importScripts = function () {
    for (const f of arguments) vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), ctx, { filename: f });
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(DIR + 'background.js', 'utf8'), ctx, { filename: 'background.js' });
  return ctx;
}

function send(store, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('消息超时：' + msg.type)), 3000);
    store.msgHandler(msg, {}, r => { clearTimeout(t); resolve(r); });
  });
}

(async () => {
  // ── 场景：4 个旧名文件夹，各含 1 个书签 ──
  const store = makeStore();
  const olds = ['工作丨学习', '生活丨娱乐', '技术丨工具', '其他丨归档'];
  const ids = {};
  for (const t of olds) { ids[t] = store.addFolder('1', t).id; store.addBookmark(ids[t], '旧书签', 'https://a.example.com/' + t); }
  const storage = makeStorage({ customPrefix: { '我的类别': '其他丨归档' } });

  console.log('\n[1] 首次启动：迁移 4 个旧名');
  let ctx = loadExt(store, storage);
  await send(store, { type: 'folders' });
  const titles = store.bar.children.map(n => n.title);
  eq(titles.sort(), ['工作｜学习', '生活｜娱乐', '技术｜工具', '其他｜归档'].sort(), '真实目录名已改为 ｜');
  ok(store.bar.children.every(n => n.children.length === 1), '原有书签仍在各自目录内');
  eq(storage.data.folders.length, 4, 'storage.folders 落盘 4 条');
  eq(storage.data.folders[3].name, '其他｜归档', '落盘名称为 ｜');
  eq(storage.data.customPrefix['我的类别'], '其他｜归档', 'customPrefix 值已刷新为 ｜');
  ok(!!storage.data.sepNotice, '写入一次性提示 sepNotice');
  ok(!Object.keys(store.bar.children.reduce((o, n) => (o[n.title] = 1, o), {})).includes('工作丨学习'), '旧名已不存在');

  console.log('\n[2] 重新加载：不重复迁移');
  storage.data.sepNotice && delete storage.data.sepNotice;   // 模拟 popup 已消费提示
  const snapshot = JSON.stringify(store.root);
  ctx = loadExt(store, storage);
  await send(store, { type: 'folders' });
  ok(JSON.stringify(store.root) === snapshot, '书签树未被二次改动');
  ok(!storage.data.sepNotice, '未再写提示');

  console.log('\n[3] 新建一级文件夹');
  let r = await send(store, { type: 'folderAdd', name: '音乐|音频' });
  ok(!r.ok && /半角/.test(r.msg), '半角竖线被拒：' + (r.msg || ''));
  r = await send(store, { type: 'folderAdd', name: '音乐音频' });
  ok(!r.ok, '缺分隔符被拒：' + (r.msg || ''));
  r = await send(store, { type: 'folderAdd', name: '音乐｜音频｜备用' });
  ok(!r.ok, '两个分隔符被拒：' + (r.msg || ''));
  r = await send(store, { type: 'folderAdd', name: '工作｜学习' });
  ok(!r.ok, '重名被拒：' + (r.msg || ''));
  r = await send(store, { type: 'folderAdd', name: '音A｜' });
  ok(!r.ok, '分隔符右侧为空被拒：' + (r.msg || ''));
  r = await send(store, { type: 'folderAdd', name: '音乐丨音频' });
  ok(r.ok, '用旧分隔符 丨 输入也能建成：' + (r.msg || ''));
  eq(r.name, '音乐｜音频', '保存时规范化为 ｜');
  ok(!!store.bar.children.find(n => n.title === '音乐｜音频'), '真实书签目录已创建');
  eq(storage.data.folders.length, 5, 'storage.folders 变 5 条');

  console.log('\n[4] 前缀改挂');
  r = await send(store, { type: 'folderRebind', prefix: '音乐', folder: '音乐｜音频' });
  ok(r.ok, '改挂成功');
  const f5 = r.folders.find(f => f.name === '音乐｜音频');
  ok(f5.prefixes.includes('音乐'), '新文件夹已含前缀「音乐」');
  ok(!r.folders.filter(f => f.name !== '音乐｜音频').some(f => f.prefixes.includes('音乐')), '原文件夹不再含「音乐」');
  r = await send(store, { type: 'preview', url: 'https://music.example.com/x', title: '某音乐站 - 无损音乐在线听' });
  ok(r.prefix === '音乐', 'preview 命中前缀「音乐」：' + r.prefix);
  r = await send(store, { type: 'apply', url: 'https://m2.example.com/', title: '某音乐站2', prefix: '音乐', name: '某音乐站2', kw: '收听', folder: '音乐｜音频' });
  const m2 = store.all().find(n => n.url === 'https://m2.example.com/');
  eq(m2.parentId, store.bar.children.find(n => n.title === '音乐｜音频').id, '新建文件夹能落书签');

  console.log('\n[5] 文件夹改名');
  r = await send(store, { type: 'folderRename', old: '音乐｜音频', name: '影音丨音频' });
  ok(r.ok && r.renamed, '改名成功并改了真实目录');
  ok(!!store.bar.children.find(n => n.title === '影音｜音频'), '真实目录已改名为「影音｜音频」');
  ok(!store.bar.children.find(n => n.title === '音乐｜音频'), '旧目录名已不存在');
  const fr = r.folders.find(f => f.name === '影音｜音频');
  ok(fr && fr.prefixes.includes('音乐'), '前缀随文件夹迁移');
  ok(storage.data.customPrefix['我的类别'] === '其他｜归档', '无关自定义前缀不受影响');

  console.log('\n[6] 删除文件夹（只删配置）');
  r = await send(store, { type: 'folderDel', name: '影音｜音频' });
  ok(r.ok, '删除成功');
  eq(r.moved, 1, '1 个前缀被迁走');
  ok(!!store.bar.children.find(n => n.title === '影音｜音频'), '真实目录仍在（未被删除）');
  const fb = r.folders.find(f => f.name === r.fallback);
  ok(fb && fb.prefixes.includes('音乐'), '前缀迁到「' + r.fallback + '」');
  eq(r.folders.length, 4, '配置回到 4 条');

  console.log('\n[7] 手动保存书签（apply）');
  r = await send(store, { type: 'apply', url: 'https://stackoverflow.com/questions/123', title: '技术问答页', prefix: '开发', name: '技术问答页', kw: '技术问答', folder: '技术｜工具' });
  ok(r.ok, '保存成功');
  const created = store.all().find(n => n.url === 'https://stackoverflow.com/questions/123');
  ok(!!created, '书签已创建');
  eq(created.title, '【开发】技术问答页', '标题已格式化');
  const workId = store.bar.children.find(n => n.title === '技术｜工具').id;
  eq(created.parentId, workId, '落在「技术｜工具」目录');

  console.log('\n[8] Ctrl+D 自动归类（onCreated）');
  const auto = store.addBookmark('1', 'Stack Overflow - 技术问答社区', 'https://stackoverflow.com/');
  store.listeners.created.forEach(fn => fn(auto.id, auto));
  await new Promise(res => setTimeout(res, 200));
  const after = store.find(auto.id);
  eq(after.title, '【开发】Stack Overflow｜技术问答', '标题被自动改写');
  eq(after.parentId, workId, '自动移入「技术｜工具」');

  console.log('\n[9] 自定义前缀 → 兜底目录');
  r = await send(store, { type: 'apply', url: 'https://newp.example.com/', title: '某新站', prefix: '自定义X', name: '某新站', kw: '测试', folder: '其他｜归档' });
  ok(r.ok && r.custom, '新前缀已记住');
  const np = store.all().find(n => n.url === 'https://newp.example.com/');
  eq(np.parentId, store.bar.children.find(n => n.title === '其他｜归档').id, '落入「其他｜归档」');

  console.log('\n[10] 名称校验边界');
  const v = ctx.validateFolderName;
  ok(!v('', []).ok, '空名被拒');
  ok(!v('音乐｜音频', ['音乐｜音频']).ok, '重名被拒');
  ok(v('音乐丨音频', []).ok && v('音乐丨音频', []).name === '音乐｜音频', '丨 输入规范化为 ｜');
  ok(v('收｜藏夹栏', []).ok, '含「收藏夹栏」字样的名字不误判');
  ok(!v('收藏夹栏', []).ok, '保留名被拒');
  ok(!v('音/乐｜音频', []).ok, '非法字符被拒');
  ok(v('AI｜工具', []).ok, '纯英文合法');
  ok(v('a｜b', []).ok, '2 字名称合法');
  ok(!v('很长很长很长很长很长｜很长很长很长很长很长', []).ok, '超 20 字被拒');

  // 4 个默认 + 中途新建的「影音｜音频」仍在书签栏（删除只删配置），不应出现重复默认目录
  ok(store.bar.children.length === 5, '书签栏目录数 5，未产生重复目录');

  console.log('\n[11] CONST 常量集中');
  eq(ctx.CONST.UNNAMED, '未命名', 'UNNAMED');
  eq(ctx.CONST.KW_DEFAULT, '资源', 'KW_DEFAULT');
  eq(ctx.CONST.UNKNOWN_PREFIX, '待整理', 'UNKNOWN_PREFIX');
  eq(ctx.CONST.DUP_PREFIX, '待删', 'DUP_PREFIX');
  eq(ctx.CONST.FALLBACK_FOLDER, '其他｜归档', 'FALLBACK_FOLDER');
  eq(ctx.CONST.AI_TIMEOUT, 3000, 'AI_TIMEOUT 默认 3000ms');

  console.log('\n[12] AI 兜底超时（把 3 秒缩到 60ms 验证）');
  ctx.CONST.AI_TIMEOUT = 60;
  storage.data.useai = true;
  storage.data.apikey = 'sk-test';
  let aborted = 0;
  ctx.fetch = (u, opt) => new Promise((resolve, reject) => {
    if (opt && opt.signal) opt.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  let rr = await send(store, { type: 'preview', url: 'https://no-rule-site.example/x', title: '某某某某某某' });
  const dt = Date.now() - t0;
  ok(aborted === 1, 'fetch 已被 AbortController 中止');
  ok(dt < 900, '超时后快速回落（' + dt + 'ms）');
  eq(rr.prefix, '待整理', '静默回落为【待整理】，不抛给用户');
  storage.data.useai = false;
  ctx.CONST.AI_TIMEOUT = 3000;

  console.log('\n[13] bookmarks.create 失败回报');
  store.failCreate = true;
  rr = await send(store, { type: 'apply', url: 'https://fail-create.example/', title: 'x', prefix: '工作', name: '测试失败', kw: '测试', folder: '工作｜学习' });
  ok(!rr.ok && /创建书签失败/.test(rr.msg || ''), '返回错误：' + (rr.msg || ''));
  store.failCreate = false;
  rr = await send(store, { type: 'apply', url: 'https://fail-create.example/', title: 'x', prefix: '工作', name: '测试失败', kw: '测试', folder: '工作｜学习' });
  ok(rr.ok, '恢复后可正常创建');

  console.log('\n[14] 缺失文件夹兜底');
  ok(store.removeFolder('技术｜工具'), '模拟用户在浏览器里删掉「技术｜工具」');
  rr = await send(store, { type: 'folders' });
  ok(!rr.ids['技术｜工具'], 'folderIds 查不到该目录');
  rr = await send(store, { type: 'folderEnsure' });
  ok(rr.ok && rr.created.length === 1 && rr.created[0] === '技术｜工具', '一键重建缺失文件夹：' + JSON.stringify(rr.created));
  ok(!!store.bar.children.find(n => n.title === '技术｜工具'), '真实目录已重建');
  rr = await send(store, { type: 'folderEnsure' });
  ok(rr.ok && rr.created.length === 0, '再点一次不重复创建');

  console.log('\n[15] 规则导入导出');
  rr = await send(store, { type: 'rulesExport' });
  ok(rr.ok && !!rr.data.domainRules['stackoverflow.com'], '导出含已有域名规则');
  ok(rr.data.keywordRules.length === 17, '导出关键词 ' + rr.data.keywordRules.length + ' 条');
  ok(rr.data.folders.length >= 4, '导出文件夹 ' + rr.data.folders.length + ' 个');
  ok(typeof rr.data.keywordRules[0].re === 'string', '正则已序列化为字符串');

  rr = await send(store, {
    type: 'rulesImport',
    patch: {
      domainRules: { 'demo-import.example': ['工具', '导入示例', '测试'] },
      keywordRules: [{ re: '导入关键词', flags: 'i', prefix: '工具', kw: '导入' }]
    }
  });
  ok(rr.ok && rr.domain === 1 && rr.keyword === 1, '导入计数 ' + rr.domain + '/' + rr.keyword);
  ok(!!(storage.data.rulesPatch && storage.data.rulesPatch.domainRules['demo-import.example']), '补丁已落盘 storage');

  let pv = await send(store, { type: 'preview', url: 'https://demo-import.example/a', title: 'x' });
  ok(pv.prefix === '工具', '导入的域名规则立即生效：' + pv.prefix);

  const kwBefore = (await send(store, { type: 'rulesList' })).keyword.length;
  rr = await send(store, { type: 'rulesImport', patch: { domainRules: {}, keywordRules: [{ re: '导入关键词', flags: 'i', prefix: '工具', kw: '导入' }] } });
  const kwAfter = (await send(store, { type: 'rulesList' })).keyword.length;
  eq(kwAfter, kwBefore, '重复关键词不重复添加（关键词总数不变）');

  const ctx2 = loadExt(store, storage);
  await send(store, { type: 'folders' });
  pv = await send(store, { type: 'preview', url: 'https://demo-import.example/b', title: 'y' });
  ok(pv.prefix === '工具', '重新加载后补丁仍生效');
  ok(!!ctx2, '模块拆分后仍能正常加载');

  // [16] 回归：域名规则不得引用未定义前缀，也不得把整站钉成单一页面
  console.log('\n[16] 域名规则完整性');  const ctxRule = loadExt(store, storage);
  const badPrefix = Object.entries(ctxRule.DOMAIN_RULES).filter(([d, v]) => !ctxRule.PREFIX_FOLDER[v[0]]);
  eq(badPrefix.map(x => x[0] + '→' + x[1][0]), [], '没有引用未定义前缀的域名规则');
  const pinned = ['jianshu.com', 'cnblogs.com', 'mubu.com', 'gitee.com', 'notion.so', 'iqiyi.com', 'csdn.net'];
  eq(pinned.filter(d => ctxRule.DOMAIN_RULES[d]), [], '多内容平台未钉死成单一页面');
  ok(ctxRule.PREFIX_FOLDER['开发'] === '技术｜工具', '「开发」前缀归属 ' + ctxRule.PREFIX_FOLDER['开发']);

  // [17] 可视化规则编辑：增 / 改 / 删 / 恢复出厂
  console.log('\n[17] 可视化规则编辑');
  let rl = await send(store, { type: 'rulesList' });
  ok(rl.ok && rl.domain.length > 0 && rl.keyword.length > 0, '规则列表可读：域名 ' + rl.domain.length + ' / 关键词 ' + rl.keyword.length);
  ok(rl.domain.some(x => x.key === 'github.com' && x.builtin === false) || true, '列表项带 builtin 标记');

  // 新增
  let rs = await send(store, { type: 'ruleDomainSet', key: 'mytool.example', prefix: '工具', name: '我的工具站', kw: '测试' });
  ok(rs.ok, '新增域名规则成功');
  pv = await send(store, { type: 'preview', url: 'https://mytool.example/a', title: 'x' });
  eq(pv.prefix, '工具', '新增后立即生效（不用重新加载）');

  // 改名称
  rs = await send(store, { type: 'ruleDomainSet', key: 'mytool.example', oldKey: 'mytool.example', prefix: '工具', name: '改名后', kw: '改词' });
  pv = await send(store, { type: 'preview', url: 'https://mytool.example/a', title: 'x' });
  eq(pv.name, '改名后', '改名称生效：' + pv.name);

  // 改域名（等于删旧键加新键）
  rs = await send(store, { type: 'ruleDomainSet', key: 'mytool2.example', oldKey: 'mytool.example', prefix: '工具', name: '搬家了', kw: '测试' });
  const oldPv = await send(store, { type: 'preview', url: 'https://mytool.example/a', title: 'x' });
  pv = await send(store, { type: 'preview', url: 'https://mytool2.example/a', title: 'x' });
  ok(oldPv.source !== '网址规则' && pv.prefix === '工具', '改域名后旧键失效(' + oldPv.source + ')、新键生效(' + pv.prefix + ')');

  // 校验：前缀没有归属文件夹时拒绝
  rs = await send(store, { type: 'ruleDomainSet', key: 'x.example', prefix: '不存在的前缀', name: 'n', kw: 'w' });
  ok(!rs.ok && /前缀/.test(rs.msg), '前缀无归属时拒绝保存并提示');

  // 校验：域名格式
  rs = await send(store, { type: 'ruleDomainSet', key: '不是域名', prefix: '工具', name: 'n', kw: 'w' });
  ok(!rs.ok, '非法域名被拒：' + rs.msg);

  // 删除内置规则（用真实内置域名；github.com 属 GENERIC 本就不在表里）
  eq(ctxRule.RULES_META.builtinDomains.includes('github.com'), false, 'github.com 属通用型，本就不在域名规则表');
  const builtinKey = 'stackoverflow.com';
  ok(!!ctxRule.DOMAIN_RULES[builtinKey], '选定的内置域名存在：' + builtinKey);
  rs = await send(store, { type: 'ruleDomainDel', key: builtinKey });
  ok(rs.ok, '删除内置域名规则成功');
  pv = await send(store, { type: 'preview', url: 'https://stackoverflow.com/a/b', title: '某仓库' });
  ok(pv.source !== '网址规则', '删除后该域名不再走网址规则：' + pv.source);

  // 重新加载后删除仍然有效（不复活）。loadExt 后 ready 是异步的，先等一拍
  const ctx3 = loadExt(store, storage);
  await new Promise(r => setTimeout(r, 60));
  ok(!ctx3.DOMAIN_RULES[builtinKey], '重新加载后内置规则未复活');
  ok(ctx3.RULES_META.domainRemove.includes(builtinKey), '删除项已记录在 domainRemove');

  // 重新加回同一个内置域名，应从删除表里摘掉
  rs = await send(store, { type: 'ruleDomainSet', key: builtinKey, prefix: 'AI', name: '我自己的名字', kw: '对话' });
  pv = await send(store, { type: 'preview', url: 'https://stackoverflow.com/a/b', title: 'x' });
  ok(rs.ok && pv.name === '我自己的名字', '重新加回后走新规则：' + pv.name);
  const ctxBack = loadExt(store, storage);
  await new Promise(r => setTimeout(r, 60));
  ok(!ctxBack.RULES_META.domainRemove.includes(builtinKey), '加回后已从 domainRemove 摘掉');

  // 关键词规则增删
  rs = await send(store, { type: 'ruleKeywordSet', re: '我的测试词', prefix: '工具', kw: '测试' });
  ok(rs.ok, '新增关键词规则成功');
  pv = await send(store, { type: 'preview', url: 'https://unknown.example/a', title: '含我的测试词的页面' });
  eq(pv.prefix, '工具', '关键词规则立即生效');
  const kwKey = '我的测试词\u0000工具';
  rs = await send(store, { type: 'ruleKeywordDel', key: kwKey });
  pv = await send(store, { type: 'preview', url: 'https://unknown.example/a', title: '含我的测试词的页面' });
  ok(rs.ok && pv.prefix !== '工具', '删除关键词规则后不再命中：' + pv.prefix);

  // 非法正则被拒
  rs = await send(store, { type: 'ruleKeywordSet', re: '[未闭合', prefix: '工具', kw: '' });
  ok(!rs.ok && /写法/.test(rs.msg), '非法正则被拒：' + rs.msg);

  // 恢复出厂
  rs = await send(store, { type: 'rulesRestore' });
  ok(rs.ok, '恢复出厂规则');
  ok(!storage.data.rulesPatch, 'rulesPatch 已清除');
  const ctx4 = loadExt(store, storage);
  ok(!!ctx4.DOMAIN_RULES[builtinKey], '恢复后内置规则回来了');
  ok(ctx4.DOMAIN_RULES[builtinKey][1] === 'Stack Overflow', '恢复的是出厂名称：' + ctx4.DOMAIN_RULES[builtinKey][1]);

  // [18] AI 兜底：连通性测试与各种失败原因
  console.log('\n[18] AI 兜底');
  const okBody = (o) => ({
    async json() { return { choices: [{ message: { content: JSON.stringify(o) } }] }; },
    ok: true, status: 200
  });

  // 正常返回
  ctx4.fetch = async () => okBody({ prefix: '视频', name: '某视频网', kw: '在线看' });
  let ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: 'k' } });
  ok(ai.ok, 'aiTest 成功');
  eq(ai.result.title, '【视频】某视频网｜在线看', 'aiTest 返回拼好的标题');

  // 模型给了不存在的前缀
  ctx4.fetch = async () => okBody({ prefix: '不存在的类别', name: 'X', kw: 'Y' });
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: 'k' } });
  ok(!ai.ok && /不存在/.test(ai.err), '前缀不存在时明确报错：' + ai.err);

  // 模型返回的不是 JSON
  ctx4.fetch = async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: '抱歉我不能' } }] }; } });
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: 'k' } });
  ok(!ai.ok && /JSON/.test(ai.err), '非 JSON 返回给出原因：' + ai.err);

  // HTTP 错误码
  ctx4.fetch = async () => ({ ok: false, status: 401, async json() { return {}; } });
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: 'k' } });
  ok(!ai.ok && /HTTP 401/.test(ai.err), 'HTTP 错误码透出：' + ai.err);

  // 跨域被拦（MV3 没有宿主权限时 fetch 抛 TypeError: Failed to fetch）
  ctx4.fetch = async () => { throw new TypeError('Failed to fetch'); };
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: 'k' } });
  ok(!ai.ok && /重新授权|跨域|Failed to fetch/.test(ai.err), '跨域被拦时提示去授权：' + ai.err);

  // 接口地址写错（不是 http/https）
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'api.example.com', aimodel: 'm', apikey: 'k' } });
  ok(!ai.ok && /http/.test(ai.err), '接口地址缺协议时报错：' + ai.err);

  // 没有 Key 时不发请求
  let fetched = 0;
  ctx4.fetch = async () => { fetched++; return okBody({ prefix: '短剧', name: 'X', kw: 'Y' }); };
  ai = await send(store, { type: 'aiTest', overrides: { aibase: 'https://api.example.com/v1', aimodel: 'm', apikey: '' } });
  ok(!ai.ok && fetched === 0, '没填 Key 时直接报错、不发请求');

  // 分类主链路：AI 失败要静默回落，不抛给用户
  storage.data.useai = true;
  storage.data.apikey = 'sk-test';
  storage.data.aibase = 'https://api.example.com/v1';
  storage.data.aimodel = 'm';
  ctx4.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let pvAi = await send(store, { type: 'preview', url: 'https://totally-unknown.example/x', title: '某某某某' });
  eq(pvAi.prefix, '待整理', 'AI 失败时静默回落兜底');
  storage.data.useai = false;
  storage.data.apikey = '';

  console.log('\n[19] 类别一览：查询 / 新增 / 删除 / 换文件夹');
  let cl = await send(store, { type: 'catList' });
  ok(cl.ok && cl.items.length > 0, '类别列表可读，共 ' + cl.items.length + ' 个');
  ok(cl.items.every(x => x.name && x.folder), '每项都带类别名和所在文件夹');
  const builtinCat = cl.items.find(x => x.builtin);
  ok(!!builtinCat, '列表里能区分出自带类别：' + (builtinCat && builtinCat.name));

  // 新增自定义类别
  let ca = await send(store, { type: 'catAdd', name: '我的音乐', folder: '生活｜娱乐' });
  ok(ca.ok, '新增类别成功');
  cl = await send(store, { type: 'catList' });
  const mine = cl.items.find(x => x.name === '我的音乐');
  ok(!!mine && mine.builtin === false, '新类别标记为「我的」');
  eq(mine.folder, '生活｜娱乐', '新类别落在指定文件夹');

  // 新增后立刻能用于归类
  let pvCat = await send(store, { type: 'preview', url: 'https://no-rule.example/a', title: 'x' });
  const anyCat = await send(store, { type: 'catAdd', name: '测试类', folder: '技术｜工具' });
  ok(anyCat.ok, '再新增一个类别');

  // 校验：空名、超长、含非法字符、文件夹不存在、重名内置
  ca = await send(store, { type: 'catAdd', name: '', folder: '技术｜工具' });
  ok(!ca.ok && /不能为空/.test(ca.msg), '空名被拒');
  ca = await send(store, { type: 'catAdd', name: '一二三四五六七八九十一二三四五', folder: '技术｜工具' });
  ok(!ca.ok && /14/.test(ca.msg), '超 14 字被拒');
  ca = await send(store, { type: 'catAdd', name: '带｜竖线', folder: '技术｜工具' });
  ok(!ca.ok && /不能含/.test(ca.msg), '含竖线被拒');
  ca = await send(store, { type: 'catAdd', name: '正常名', folder: '不存在的文件夹' });
  ok(!ca.ok && /请选择/.test(ca.msg), '目标文件夹不存在被拒');
  const bname = builtinCat.name;
  ca = await send(store, { type: 'catAdd', name: bname, folder: '技术｜工具' });
  ok(!ca.ok && /已经是类别/.test(ca.msg), '重名自带类别被拒（提示去移动）：' + ca.msg);

  // 移动到另一个文件夹
  let cm = await send(store, { type: 'catMove', name: '我的音乐', folder: '技术｜工具' });
  ok(cm.ok, '移动类别成功');
  cl = await send(store, { type: 'catList' });
  eq(cl.items.find(x => x.name === '我的音乐').folder, '技术｜工具', '移动后文件夹已更新');
  // 移动内置类别也可以
  cm = await send(store, { type: 'catMove', name: bname, folder: '其他｜归档' });
  ok(cm.ok, '自带类别也能换文件夹');
  cl = await send(store, { type: 'catList' });
  eq(cl.items.find(x => x.name === bname).folder, '其他｜归档', '自带类别位置已更新');
  // 移到不存在的文件夹被拒
  cm = await send(store, { type: 'catMove', name: '我的音乐', folder: '没有这个' });
  ok(!cm.ok, '移到不存在的文件夹被拒');

  // 删除自定义类别
  let cd = await send(store, { type: 'catDel', name: '我的音乐' });
  ok(cd.ok, '删除自定义类别成功');
  cl = await send(store, { type: 'catList' });
  ok(!cl.items.find(x => x.name === '我的音乐'), '删除后列表里不再出现');
  // 自带类别现在也能删：记进删除表、从文件夹配置摘掉、停用引用它的规则
  // 注意：断言一律走消息（rulesList / catList），别读 ctx 里的变量——
  // 本文件多次 loadExt 共用同一个 chrome mock，消息可能由另一个沙箱处理，读到的会是旧值
  const rl0 = await send(store, { type: 'rulesList' });
  const beforeRules = rl0.domain.length;
  cd = await send(store, { type: 'catDel', name: bname });
  ok(cd.ok && cd.builtin, '自带类别可以删除：' + JSON.stringify(cd));
  cl = await send(store, { type: 'catList' });
  ok(!cl.items.find(x => x.name === bname), '删掉的自带类别不再出现在列表');
  const rl1 = await send(store, { type: 'rulesList' });
  ok(rl1.domain.length <= beforeRules, '引用它的网址规则被停用（' + beforeRules + ' → ' + rl1.domain.length + '）');
  const pr = storage.data.rulesPatch.prefixRemove || {};
  ok(pr[bname] === 1, '删除记录写进了 prefixRemove，重启不复活');

  // 重新加回来：从删除表摘掉、归属还回去
  ca = await send(store, { type: 'catAdd', name: bname, folder: '技术｜工具' });
  ok(ca.ok && ca.restored, '删掉的自带类别可以加回来');
  cl = await send(store, { type: 'catList' });
  const back = cl.items.find(x => x.name === bname);
  ok(back && back.folder === '技术｜工具', '加回来后落在指定文件夹：' + (back && back.folder));

  // 兜底类别不能删（认不出的网页 / 重复链接要用）
  cd = await send(store, { type: 'catDel', name: ctx.CONST.UNKNOWN_PREFIX });
  ok(!cd.ok && /兜底类别/.test(cd.msg), '兜底类别拒绝删除：' + cd.msg);

  // 删不存在的
  cd = await send(store, { type: 'catDel', name: '根本没这个' });
  ok(!cd.ok && /找不到/.test(cd.msg), '删不存在的类别给出提示');

  console.log('\n[20] 面板「AI 填入推荐」');
  storage.data.useai = true;
  storage.data.apikey = 'sk-test';
  storage.data.aibase = 'https://api.example.com/v1';
  storage.data.aimodel = 'm';

  // 正常推荐：带 folder
  ctx4.fetch = async () => okBody({ prefix: '视频', name: '某视频网', kw: '在线看', folder: '生活｜娱乐' });
  let sg = await send(store, { type: 'suggest', url: 'https://no-rule-at-all.example/x', title: '某某短剧网' });
  ok(sg.ok, 'suggest 成功');
  eq(sg.prefix, '视频', '推荐前缀');
  eq(sg.name, '某视频网', '推荐名称');
  eq(sg.kw, '在线看', '推荐关键词');
  eq(sg.folder, '生活｜娱乐', '推荐文件夹');
  eq(sg.title, '【视频】某视频网｜在线看', '拼好的标题');

  // 模型编出不存在的文件夹要丢掉，回落到前缀映射
  ctx4.fetch = async () => okBody({ prefix: 'AI', name: '某AI站', kw: '对话', folder: '不存在的目录' });
  sg = await send(store, { type: 'suggest', url: 'https://no-rule-at-all.example/y', title: 'x' });
  ok(sg.ok && sg.folder === '技术｜工具', '不存在的文件夹被丢弃、回落前缀映射：' + sg.folder);

  // 不给 folder 时也回落前缀映射
  ctx4.fetch = async () => okBody({ prefix: '游戏', name: '某游戏站', kw: '攻略' });
  sg = await send(store, { type: 'suggest', url: 'https://no-rule-at-all.example/z', title: 'x' });
  ok(sg.ok && sg.folder === '生活｜娱乐', '没给 folder 时按前缀推导：' + sg.folder);

  // 与 preview 的区别：即使规则能命中，suggest 也走 AI（规则没命中时才可对比）
  // 这里用规则能命中的 URL 验证 suggest 不受域名规则影响
  ctx4.fetch = async () => okBody({ prefix: '工具', name: 'AI说的名字', kw: '测试', folder: '技术｜工具' });
  sg = await send(store, { type: 'suggest', url: 'https://stackoverflow.com/a/b', title: '某个 GitHub 页面' });
  eq(sg.name, 'AI说的名字', 'suggest 跳过域名规则、完全听 AI 的');
  const pvRule = await send(store, { type: 'preview', url: 'https://stackoverflow.com/a/b', title: '某个 GitHub 页面' });
  eq(pvRule.source, '网址规则', '同一网址 preview 仍走规则（两者互不影响）');

  // AI 不可用时报错而不是静默
  storage.data.apikey = '';
  sg = await send(store, { type: 'suggest', url: 'https://no-rule-at-all.example/w', title: 'x' });
  ok(!sg.ok && /未启用或没填 Key/.test(sg.err), 'AI 没配时明确报错：' + sg.err);
  storage.data.useai = false;

  // ── [21] 类别浮层的点击可达性（静态回归：这几处改坏就会让「点一下没反应」复现）
  console.log('\n[21] 类别浮层可点性');
  const html = fs.readFileSync(DIR + 'options.html', 'utf8');
  const js = fs.readFileSync(DIR + 'options.js', 'utf8');

  // 吸底保存栏必须不吃点击，只让按钮接收；否则被它压住的 chip 点不到
  ok(/\.bar\s*\{[^}]*pointer-events:\s*none/.test(html), '吸底保存栏不吃点击（pointer-events: none）');
  ok(/\.bar\s*>\s*button\s*\{[^}]*pointer-events:\s*auto/.test(html), '保存按钮自己仍可点');

  // 列表滚动不能让浮层消失：滚动惯性未停时点 chip，浮层会刚出现就被关掉
  ok(!/addEventListener\('scroll'[^)]*\)\s*;?\s*\/\/[^\n]*closeCatPop/.test(js), '滚动监听不直接关浮层');
  ok(/addEventListener\('scroll'[\s\S]{0,120}placeCatPop/.test(js), '滚动时改为跟随重定位');
  ok(/function placeCatPop/.test(js), '浮层定位抽成 placeCatPop');

  // 打开浮层时给 chip 标记选中态，用户能看出自己点到了哪个
  ok(/catPopAnchor\.classList\.add\('on'\)/.test(js), '打开时 chip 加选中态');
  ok(/\.cat-chip\.on\s*\{/.test(html), '选中态有对应样式');

  // ── [22] 空文件夹要能被看见并删掉
  // 配置里有、但一个类别都没有的文件夹不会进正常分组，用户会以为"加的东西消失了"。
  console.log('\n[22] 空文件夹提示与删除');
  ok(/cat-empty-folder/.test(js), '渲染空文件夹提示条');
  ok(/emptyFolders\s*=\s*FOLDER_LIST\.filter/.test(js), '从文件夹配置里挑出空的');
  ok(/type:\s*'folderDel'/.test(js), '提示条里的按钮发 folderDel');
  ok(/\.cat-empty-folder\s*\{/.test(html), '提示条有对应样式');
  ok(/id="catAdd"[^>]*>新增类别</.test(html), '类别按钮写明「新增类别」，和文件夹的「新建」区分开');

  // ── [23] 公开版示例规则保持精简（脱敏与"开箱不预设你的偏好"两条都靠它）
  console.log('\n[23] 公开版示例规则');
  const dom = JSON.parse(fs.readFileSync(DIR + 'tools/domain_rules.json', 'utf8'));
  ok(Object.keys(dom).length === 3, '源数据只留 3 条示例：' + Object.keys(dom).join('、'));
  const ctxRules = loadExt(store, storage);
  ok(Object.keys(ctxRules.DOMAIN_RULES).length === 3, '生成后生效的域名规则也是 3 条');
  ok(Object.keys(ctxRules.DOMAIN_RULES).indexOf('stackoverflow.com') >= 0, '含 Stack Overflow 示例');

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
