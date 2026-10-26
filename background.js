// background.js —— MV3 service worker 入口，只负责按顺序加载模块
// 顺序不能乱：rules（数据与工具）→ bookmarks（书签原语）→ classify（判定链）→ router（组装与路由）
importScripts('rules.js', 'bookmarks.js', 'classify.js', 'router.js');
