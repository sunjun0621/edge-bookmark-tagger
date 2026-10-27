// 规则库（由 gen_rules.py 生成，勿手改；改规则请改脚本或直接编辑本文件的常量）
// 1) DOMAIN_RULES 域名 → [前缀, 名称, 关键词]
// 2) KEYWORD_RULES 关键词 → 前缀（域名未命中时用）
// 3) DEFAULT_FOLDERS 默认四个一级文件夹与前缀归属（出厂值，用户可增删）
// 4) FOLDERS 运行时副本：启动时被 chrome.storage.local.folders 覆盖
// 改完在 edge://extensions 点"重新加载"生效。

var DOMAIN_RULES = {"stackoverflow.com":["开发","Stack Overflow","技术问答"],"youtube.com":["视频","YouTube","在线观看"],"chatgpt.com":["AI","ChatGPT","对话"]};

// 内置规则的键值快照：编辑规则时用来区分「内置」与「用户新增」，也用于一键撤销
// domainRemove / keywordRemove 由 storage.rulesPatch 恢复，决定哪些内置规则被停用
var RULES_META = { builtinDomains: [], builtinKeywords: [], domainRemove: [], keywordRemove: [] };

// 全局文案与默认值：background / popup / options 唯一来源，别处不要再写死
var CONST = {
  UNNAMED: '未命名',
  KW_DEFAULT: '资源',
  UNKNOWN_PREFIX: '待整理',
  UNKNOWN_KW: '未分类',
  DUP_PREFIX: '待删',
  DUP_KW: '重复',
  FALLBACK_FOLDER: '其他｜归档',
  NAME_MAX: 14,
  KW_MAX: 8,
  AI_TIMEOUT: 3000
};

var DEFAULT_FOLDERS = [
  { name: '工作｜学习', prefixes: ['工作', '办公', '写作', '学习', '邮箱'] },
  { name: '生活｜娱乐', prefixes: ['影视', '视频', '音乐', '动漫', '阅读', '播客', '游戏', '壁纸', '摄影', '购物', '社交', '资讯'] },
  { name: '技术｜工具', prefixes: ['AI', 'API', '域名', '服务器', '网络', 'GitHub', '开发', '脚本', '扩展', '软件', '系统', 'Android', '工具', '搜索', '网盘', '图标', '硬件', '论坛', '导航', '笔记'] },
  { name: CONST.FALLBACK_FOLDER, prefixes: ['其他', CONST.UNKNOWN_PREFIX, CONST.DUP_PREFIX] }
];

// 运行时副本：background 启动时用 storage.folders 原地覆盖（保持数组引用不变，popup/options 直读）
var FOLDERS = DEFAULT_FOLDERS.map(function (f) {
  return { name: f.name, prefixes: f.prefixes.slice() };
});

// 前缀 → 文件夹名。运行时由 rebuildPrefixMap() 原地重填，对象引用不变
var PREFIX_FOLDER = {};

function rebuildPrefixMap() {
  var k, i, j, f;
  for (k in PREFIX_FOLDER) delete PREFIX_FOLDER[k];
  for (i = 0; i < FOLDERS.length; i++) {
    f = FOLDERS[i];
    for (j = 0; j < f.prefixes.length; j++) PREFIX_FOLDER[f.prefixes[j]] = f.name;
  }
  return PREFIX_FOLDER;
}
rebuildPrefixMap();

// 一级文件夹名规范：XX｜XX，分隔符统一 U+FF5C 全角竖线；旧名 U+4E28「丨」自动迁移
var FOLDER_SEP = '｜';
var FOLDER_SEP_ALT = '丨';
var OLD_FOLDER_NAMES = {
  '工作丨学习': '工作｜学习',
  '生活丨娱乐': '生活｜娱乐',
  '技术丨工具': '技术｜工具',
  '其他丨归档': '其他｜归档'
};
var FOLDER_RESERVED = ['收藏夹栏', '书签栏', 'Bookmarks bar'];
var FOLDER_BAD_CHARS = '/\\:*?"<>｜丨|＼／：＊？＂＜＞';

// 校验一级文件夹名。返回 { ok, name, msg }；name 为规范化后的名字（分隔符已统一为 ｜）
// taken：已占用的名字数组（改名时请先排除自身）
function validateFolderName(raw, taken) {
  var name = String(raw || '').trim();
  if (!name) return { ok: false, msg: '名称不能为空' };
  if (FOLDER_RESERVED.indexOf(name) >= 0) return { ok: false, msg: '不能使用系统保留名「' + name + '」' };
  var seps = 0, idx = -1, i, ch;
  for (i = 0; i < name.length; i++) {
    ch = name.charAt(i);
    if (ch === FOLDER_SEP || ch === FOLDER_SEP_ALT) { seps++; if (idx < 0) idx = i; }
  }
  if (seps === 0 && name.indexOf('|') >= 0) return { ok: false, msg: '分隔符请用全角「｜」(U+FF5C)，不要用半角「|」' };
  if (seps === 0) return { ok: false, msg: '缺少分隔符，格式为「名称｜名称」，如「音乐｜音频」' };
  if (seps > 1) return { ok: false, msg: '分隔符只能有一个（当前 ' + seps + ' 个）' };
  var left = name.slice(0, idx).trim();
  var right = name.slice(idx + 1).trim();
  if (!left || !right) return { ok: false, msg: '分隔符两侧各需至少 1 个字符' };
  var norm = left + FOLDER_SEP + right;
  if (norm.length < 2 || norm.length > 20) return { ok: false, msg: '长度需为 2–20 字（当前 ' + norm.length + ' 字）' };
  for (i = 0; i < norm.length; i++) {
    ch = norm.charAt(i);
    if (ch === FOLDER_SEP || ch === FOLDER_SEP_ALT) continue;
    if (FOLDER_BAD_CHARS.indexOf(ch) >= 0) return { ok: false, msg: '不能含 / \\ : * ? " < > 等符号' };
  }
  if (taken && taken.indexOf(norm) >= 0) return { ok: false, msg: '已存在同名文件夹「' + norm + '」' };
  return { ok: true, name: norm };
}

// 自定义前缀 → 文件夹（用户在 popup/设置里自己加，存 chrome.storage）
var CUSTOM_PREFIX = {};

// 标题拼装唯一入口：
//   关键词是名称尾部时，从名称里剪掉它（福利学术导航+导航 → 福利学术｜导航）
//   剪完太短（<3字）或关键词夹在中间时，省掉关键词段，保住完整可搜词（腾讯会议+会议 → 腾讯会议）
function buildTitle(prefix, name, kw) {
  let nm = String(name || '').trim();
  let k = String(kw || '').trim();
  if (!prefix) return nm;
  if (!k) return '【' + prefix + '】' + nm;
  if (nm.length > k.length && nm.slice(-k.length) === k) {
    const rem = nm.slice(0, nm.length - k.length).trim();
    if (rem.length >= 3) nm = rem; else k = '';
  } else if (nm.indexOf(k) >= 0 || (nm.length >= 2 && k.indexOf(nm) >= 0)) {
    k = '';
  }
  return k ? '【' + prefix + '】' + nm + '｜' + k : '【' + prefix + '】' + nm;
}

// 是否已是本规范标题：前缀白名单精确判定（含自定义），避免网页标题【公告】被误判
function isFormatted(title) {
  const m = /^【([^】]{1,14})】(.+)$/.exec(String(title || ''));
  if (!m) return false;
  const p = m[1].trim();
  return !!(PREFIX_FOLDER[p] || CUSTOM_PREFIX[p]);
}

// 顺序敏感：先命中先用，越具体的判断放越前
var KEYWORD_RULES = [
  { re: /api|中转|relay|openai|claude|gpt|llm|模型接口/i, prefix: 'API', kw: '接口' },
  { re: /poe|暗黑|魔兽|wow|steam|游戏|game/i, prefix: '游戏', kw: '攻略' },
  { re: /root|magisk|kernelsu|xposed|apk|android|安卓/i, prefix: 'Android', kw: 'APP' },
  { re: /域名|nameserver/i, prefix: '域名', kw: '解析' },
  { re: /vps|服务器|主机|hosting|机房/i, prefix: '服务器', kw: 'VPS' },
  { re: /github|gitlab|gitee/i, prefix: 'GitHub', kw: '代码' },
  { re: /影视|电影|电视剧|在线观看|vod/i, prefix: '影视', kw: '在线看' },
  { re: /壁纸|wallpaper/i, prefix: '壁纸', kw: '图片' },
  { re: /漫画|动漫|anime/i, prefix: '动漫', kw: '在线看' },
  { re: /音乐|music|无损/i, prefix: '音乐', kw: '收听' },
  { re: /小说|书源|阅读|legado/i, prefix: '阅读', kw: '书源' },
  { re: /会议|meeting/i, prefix: '办公', kw: '会议' },
  { re: /文档|office|wps|excel|word|pdf/i, prefix: '办公', kw: '文档' },
  { re: /考研|mooc|课程|学习|考试|题库/i, prefix: '学习', kw: '课程' },
  { re: /软件下载|绿色版|汉化/i, prefix: '软件', kw: '下载' },
  { re: /系统|winos|重装|iso|装机/i, prefix: '系统', kw: '镜像' },
  { re: /工具|tool|convert|转换/i, prefix: '工具', kw: '在线工具' }
];

var NOISE = /(官网|官方网站|首页|官方站|最新版|免费在线|在线观看|欢迎您|欢迎光临)/g;
var SUFFIX = /(壁纸|游戏|影视|下载站|导航|论坛|中心|平台|网|站)$/;
var SEPARATOR = /[|｜\-–—_·•:：,，]|\s{2,}/;

function stripEdge(s) {
  return (s || '')
    .replace(/^[\s·•–—_|｜:：,，.。!！?？;；~～-]+/, '')
    .replace(/[\s·•–—_|｜:：,，.。!！?？;；~～-]+$/, '');
}

var LEAD = /^(推荐|攻略|搬运|转载|合集|精品|热门|更新|福利|收藏|分享|原创|整理|汇总|首页|官网|官网首页)$/;

function cleanName(raw) {
  let t = (raw || '').trim();
  t = t.replace(/^[\u2600-\u27BF\uFE0F\u2B00-\u2BFF★☆⭐\s]+/, '');
  // 装饰符号统一换成空格，避免《冒险岛 与 攻略怪物猎人 两类残缺/粘连
  t = t.replace(/[《》〈〉「」『』【】（）()［］｛｝{}“”‘’"'']/g, ' ').replace(/[\[\]]/g, ' ');
  let parts = t.split(SEPARATOR).map(stripEdge).map(x => x.replace(LEAD, '').replace(/^(推荐|攻略|搬运|转载|合集|精品|热门|福利|原创|整理)\s+/, '')).map(stripEdge).filter(Boolean);
  const solid = parts.filter(x => !LEAD.test(x));
  if (solid.length) parts = solid;
  if (parts.length > 1) t = parts[0].length >= 2 ? parts[0] : parts.slice().sort((a, b) => b.length - a.length)[0];
  else t = parts[0] || stripEdge(t);
  t = stripEdge(t.replace(NOISE, '').replace(/[丨｜|]/g, ' '));
  const cut = stripEdge(t.replace(SUFFIX, ''));
  if (cut.length >= 4) t = cut;
  if (!t) t = (raw || '').slice(0, 14);
  if (t.length > 14) t = t.slice(0, 14);
  return stripEdge(t) || '未命名';
}

function hostOf(url) {
  try {
    const u = new URL(url);
    let h = u.hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  } catch (e) { return ''; }
}

// 域名逐级回退：a.b.example.com → b.example.com → example.com
function domainHit(url) {
  const parts = hostOf(url).split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts.slice(i).join('.');
    if (DOMAIN_RULES[key]) return DOMAIN_RULES[key];
  }
  return null;
}

// 记下内置规则的键值，供设置页区分「内置」与「用户新增」（用户删除内置规则后可撤销）
RULES_META.builtinDomains = Object.keys(DOMAIN_RULES);
RULES_META.builtinKeywords = KEYWORD_RULES.map(function (r) { return r.re.source + '\u0000' + r.prefix; });
