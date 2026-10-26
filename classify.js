// classify.js —— 判定链（域名 → 关键词 → AI → 兜底）+ 规则导入导出
// 依赖 rules.js；cfg() 由 router.js 提供（调用时已加载）

function kwFallback(prefix, matched) {
  const m = (matched || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  if (m && m.length <= 6 && m !== prefix) return m;
  return CONST.KW_DEFAULT;
}

function ruleClassify(title, url) {
  const hit = domainHit(url);
  if (hit) return { prefix: hit[0], name: hit[1], kw: hit[2], source: '网址规则' };
  const text = (title || '') + ' ' + (url || '');
  for (const r of KEYWORD_RULES) {
    const m = text.match(r.re);
    if (m) return { prefix: r.prefix, name: cleanName(title), kw: r.kw || kwFallback(r.prefix, m[0]), source: '关键词规则' };
  }
  return null;
}

// 调一次 AI。返回 { r, err }：r 为解析后的结果（可能 null），err 为失败原因
// awaitPerm=true 时先确保已获得该接口的跨域权限（MV3 没有权限会被 CORS 直接拦掉）
// force=true 时不看规则、直接让 AI 推荐（面板「AI 填入」用），并把文件夹建议带回来
async function aiCall(title, url, c, awaitPerm, force) {
  if (!c.useai || !c.apikey) return { r: null, err: '未启用或没填 Key' };
  const base = String(c.aibase || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { r: null, err: '接口地址要以 http:// 或 https:// 开头' };

  const prefixes = Object.keys(PREFIX_FOLDER).join('、');
  const folders = FOLDERS.map(f => f.name).join('、');
  // 已存在的一级文件夹清单：让模型只能选这些，避免编出不存在的目录
  const folderHint = folders ? `\n可选文件夹（可留空）：${folders}` : '';
  const extra = force
    ? `\n另外给出 folder：从上面的可选文件夹里挑最合适的，实在不合适就留空字符串。`
    : '';
  const body = {
    model: c.aimodel,
    temperature: force ? 0.4 : 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '你是浏览器书签归档器。只输出 JSON，无其他文字。' },
      {
        role: 'user',
        content: `网页标题：${title}\n网址：${url}\n\n从下列 prefix 中选一个：${prefixes}${folderHint}\n输出 JSON：{"prefix":"...","name":"站点名，≤14字，不含丨｜和【】","kw":"用途关键词，≤8字，不含空格"${force ? ',"folder":"..."' : ''}}${extra}`
      }
    ]
  };

  // 没有该 origin 的宿主权限时，fetch 会被 CORS 拦成 TypeError: Failed to fetch，
  // 这里先补申请，用户点一下授权就能用
  if (awaitPerm) {
    try {
      const origin = new URL(base).origin + '/*';
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (!has) await chrome.permissions.request({ origins: [origin] });
    } catch (e) { /* permissions API 不可用时直接尝试请求 */ }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONST.AI_TIMEOUT);
  let resp;
  try {
    resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apikey },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { r: null, err: aborted ? '超时（' + CONST.AI_TIMEOUT + 'ms）' : '请求失败：' + ((e && e.message) || e) + '（多半是接口没给跨域授权，点「重新授权」）' };
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return { r: null, err: '接口返回 HTTP ' + resp.status };

  let j;
  try { j = await resp.json(); } catch (e) { return { r: null, err: '返回的不是 JSON' }; }
  let txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { r: null, err: '模型没按格式返回 JSON' };
  let o;
  try { o = JSON.parse(m[0]); } catch (e) { return { r: null, err: '返回的 JSON 解析失败' }; }
  if (!o.prefix) return { r: null, err: '模型没给出 prefix' };
  if (!PREFIX_FOLDER[o.prefix] && !CUSTOM_PREFIX[o.prefix]) return { r: null, err: 'AI 给的类别「' + o.prefix + '」不存在' };

  const name = String(o.name || '').replace(/[【】丨｜]/g, '').slice(0, CONST.NAME_MAX) || cleanName(title);
  const kw = String(o.kw || '').replace(/[【】丨｜\s]/g, '').slice(0, CONST.KW_MAX) || CONST.KW_DEFAULT;
  // 文件夹只认已存在的，模型编出来的直接丢掉
  let folder = '';
  if (force && o.folder) {
    const want = String(o.folder).trim();
    if (FOLDERS.some(f => f.name === want)) folder = want;
  }
  const out = { prefix: o.prefix, name, kw, source: force ? 'AI 推荐' : 'AI 判断' };
  if (folder) out.folder = folder;
  return { r: out, err: '' };
}

async function aiClassify(title, url, c, awaitPerm) {
  const { r } = await aiCall(title, url, c, awaitPerm);
  return r;
}

async function classify(title, url, c) {
  c = c || (await cfg());
  const r = ruleClassify(title, url);
  if (r) return r;
  try {
    const a = await aiClassify(title, url, c, false);
    if (a) return a;
  } catch (e) {
    console.warn('AI 失败，走兜底：', e);
  }
  if (c.unknown === 'keep') return { prefix: '', name: cleanName(title), kw: '', source: '未归类（保持原状）' };
  return { prefix: CONST.UNKNOWN_PREFIX, name: cleanName(title), kw: CONST.UNKNOWN_KW, source: '没认出来' };
}

function titleOf(r) {
  return buildTitle(r.prefix, r.name, r.kw);
}

// ── 规则导入导出（正则序列化为 source + flags）──────────────

function exportRules() {
  let ver = '';
  try { ver = chrome.runtime.getManifest().version; } catch (e) {}
  return {
    app: 'edge-bookmark-tagger',
    version: ver,
    exportedAt: new Date().toISOString(),
    folders: FOLDERS.map(f => ({ name: f.name, prefixes: f.prefixes.slice() })),
    customPrefix: Object.assign({}, CUSTOM_PREFIX),
    domainRules: Object.assign({}, DOMAIN_RULES),
    keywordRules: KEYWORD_RULES.map(r => ({ re: r.re.source, flags: r.re.flags, prefix: r.prefix, kw: r.kw || '' })),
    domainRemove: RULES_META.domainRemove.slice(),
    keywordRemove: RULES_META.keywordRemove.slice()
  };
}

// ── 规则补丁（可视化编辑 / 导入导出共用）────────────────────────
// 补丁是「相对内置规则的一整套变更」：增改放 domainRules / keywordRules，
// 停用的内置项放 domainRemove / keywordRemove。每次应用都从内置快照重建，
// 这样删掉的能删干净、恢复出厂也是一句话——不要改成原地叠加，会留下残影。

// 内置基线（首次调用时快照，之后重建都以它为准）
let BASELINE = null;
function baseline() {
  if (!BASELINE) {
    BASELINE = {
      domain: Object.assign({}, DOMAIN_RULES),
      keyword: KEYWORD_RULES.map(r => ({ re: r.re, prefix: r.prefix, kw: r.kw || '' })),
      builtinDomains: RULES_META.builtinDomains.slice(),
      builtinKeywords: RULES_META.builtinKeywords.slice()
    };
  }
  return BASELINE;
}

// 把补丁整体应用：先把内存规则还原成内置基线，再按补丁增删
function applyRulesPatch(patch) {
  const base = baseline();
  const p = patch || {};
  const domainRemove = p.domainRemove || [];
  const keywordRemove = p.keywordRemove || [];
  const domainAdd = p.domainRules || {};
  const keywordAdd = Array.isArray(p.keywordRules) ? p.keywordRules : [];

  // 1) 域名：还原基线 → 摘掉停用项 → 覆盖增改
  for (const k in DOMAIN_RULES) delete DOMAIN_RULES[k];
  for (const k in base.domain) DOMAIN_RULES[k] = base.domain[k];
  for (const k of domainRemove) delete DOMAIN_RULES[k];
  let dc = 0;
  for (const k in domainAdd) {
    const v = domainAdd[k];
    if (!Array.isArray(v) || v.length < 3) continue;
    DOMAIN_RULES[k] = v;
    if (!(k in base.domain)) dc++;   // 只统计真正新增的，改内置的不算
  }

  // 2) 关键词：还原基线（顺序敏感，必须整体重排）→ 摘掉停用项 → 追加新增
  const gone = new Set(keywordRemove);
  const kept = base.keyword.filter(r => !gone.has(r.re.source + '\u0000' + r.prefix));
  let kc = 0;  const baseKw = new Set(base.keyword.map(r => r.re.source + '\u0000' + r.prefix));
  for (const r of keywordAdd) {
    if (!r || !r.re || !r.prefix) continue;
    let re;
    try { re = new RegExp(r.re, r.flags || 'i'); } catch (e) { continue; }
    if (kept.some(x => x.re.source === re.source && x.prefix === r.prefix)) continue;
    kept.push({ re, prefix: r.prefix, kw: r.kw || '' });
    if (!baseKw.has(re.source + '\u0000' + r.prefix)) kc++;
  }
  KEYWORD_RULES.length = 0;
  for (const r of kept) KEYWORD_RULES.push(r);

  RULES_META.domainRemove = domainRemove.slice();
  RULES_META.keywordRemove = keywordRemove.slice();
  return { domain: dc, keyword: kc };
}
