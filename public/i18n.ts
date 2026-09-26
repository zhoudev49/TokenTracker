// i18n.ts — 中英双语（zh / en）。以 classic script 形式在 common.js 之前加载。
// 语言偏好存 localStorage（token-tracker-lang），未设置时跟随浏览器语言。
// 静态文本通过 data-i18n / data-i18n-placeholder / data-i18n-title 标记，
// 动态文本在渲染时调用 I18N.t(key) 获取。切换语言时通过 onChange 回调让各页面重渲染。
// 编译产物仍为普通脚本（本文件不含 import/export）。
(function () {
  "use strict";

  const STORAGE_KEY = "token-tracker-lang";

  const dict = {
    zh: {
      "lang.switch": "EN",
      "lang.hint": "切换到英文 / Switch to English",

      "nav.aria": "主导航",
      "filter.aria": "全局筛选",

      "brand.tagline": "多平台 AI 编码用量分析",

      "status.connecting": "正在连接",
      "status.refreshing": "正在刷新",
      "status.online": "更新于 {0}",
      "status.ready": "就绪",
      "status.initFailed": "初始化失败",
      "status.serverDown": "初始化失败。确认服务端已启动。",
      "status.connFailed": "连接失败",
      "status.loadFailed": "数据加载失败。检查服务端日志后重试。",
      "status.detailLoadFailed": "会话详情加载失败。",

      "filter.startDate": "开始日期",
      "filter.endDate": "结束日期",
      "filter.sep": "至",
      "filter.platform": "平台",
      "filter.project": "项目",
      "filter.model": "模型",
      "filter.allPlatforms": "全部平台",
      "filter.allProjects": "全部项目",
      "filter.allModels": "全部模型",
      "filter.reset": "重置",
      "filter.sync": "立即同步",

      "sync.scanning": "正在扫描日志并导入新增记录。",
      "sync.complete": "同步完成：扫描 {0} 个文件，更新 {1} 个，写入 {2} 条事件，失败 {3} 个。",
      "sync.failed": "同步失败。查看服务端日志。",

      "metric.totalTokens": "筛选范围 Token",
      "metric.input": "输入 Token",
      "metric.output": "输出 Token",
      "metric.sessions": "会话数",

      "cache.efficiency": "缓存读取率",
      "cache.read": "缓存读取",
      "cache.written": "缓存创建",
      "cache.total": "缓存 Token 合计",

      "chart.trend": "最近 30 天趋势",
      "chart.modelShare": "模型消耗占比",
      "chart.noData": "暂无数据",
      "chart.tokenValue": "Token: {0}",
      "chart.tokensPct": "{0} Token · {1}%",

      "projects.title": "项目用量",
      "projects.count": "{0} 个项目",
      "projects.empty": "当前条件下没有项目数据",
      "projects.viewSessions": "查看该项目的会话",
      "projects.column.project": "项目",
      "projects.column.sessions": "会话",
      "projects.column.model": "主要模型",
      "projects.column.total": "总 Token",
      "projects.column.efficiency": "缓存读取率",

      "sessions.title": "会话列表",
      "sessions.records": "{0} 条记录",
      "sessions.pageInfo": "第 {0} / {1} 页",
      "sessions.empty": "当前条件下没有会话数据",
      "sessions.searchPlaceholder": "搜索会话、项目或模型",
      "sessions.perPage20": "20 / 页",
      "sessions.perPage50": "50 / 页",
      "sessions.perPage100": "100 / 页",
      "sessions.export": "导出",
      "sessions.tokensUsed": "使用 {0} tokens",
      "sessions.modelSep": "、",
      "sessions.first": "首页",
      "sessions.prev": "上一页",
      "sessions.next": "下一页",
      "sessions.last": "尾页",
      "sessions.jump": "跳转",
      "sessions.pagePlaceholder": "页",
      "sessions.loading": "正在加载",
      "sessions.column.sessionId": "会话 ID",
      "sessions.column.project": "项目",
      "sessions.column.lastActivity": "最后活动",
      "sessions.column.model": "模型",
      "sessions.column.input": "输入",
      "sessions.column.output": "输出",
      "sessions.column.cacheRead": "缓存读取",
      "sessions.column.cacheWrite": "缓存创建",
      "sessions.column.total": "总 Token",
      "sessions.column.platform": "平台",

      "detail.title": "会话详情",
      "detail.back": "返回会话列表",
      "detail.loading": "正在加载",
      "detail.missingId": "缺少 sessionId 参数。",
      "detail.subtitle": "{0} · {1}",
      "detail.loadingPrompt": "正在加载对话内容…",
      "detail.promptFailed": "对话内容加载失败。",
      "detail.noText": "（无文本内容）",
      "detail.emptyEvents": "该会话没有事件记录",
      "detail.clickToExpand": "（点击展开以加载对话内容）",
      "detail.pageInfo": "第 {0} / {1} 页（共 {2} 条事件）",
      "detail.summary.events": "响应事件",
      "detail.summary.total": "总 Token",
      "detail.summary.input": "输入 Token",
      "detail.summary.output": "输出 Token",
      "detail.summary.cacheRead": "缓存读取",
      "detail.h.time": "时间",
      "detail.h.model": "模型",
      "detail.h.input": "输入",
      "detail.h.output": "输出",
      "detail.h.cacheRead": "缓存读",
      "detail.h.cacheWrite": "缓存写",
      "detail.h.total": "总量",

      "seg.text": "文本",
      "seg.thinking": "[思考]",
      "seg.toolCall": "[工具调用: {0}]",
      "seg.toolResult": "[工具返回]",
      "seg.toolResultError": "[工具返回(错误)]",
      "side.userToolResult": "工具返回 (tool_result)",
      "side.userMixed": "用户输入 / 工具返回",
      "side.user": "用户输入 (user_prompt)",
      "side.toolUse": "工具调用 (tool_use)",
      "side.assistantMixed": "模型回复 / 工具调用",
      "side.assistant": "模型回复 (assistant_prompt)",

      "settings.title": "设置",
      "settings.meta": "仅保存在本机浏览器",
      "settings.refreshInterval": "页面刷新间隔（秒）",
      "settings.note": "本工具只统计 token 用量与会话详情，不涉及任何价格或费用信息。设置保存在浏览器本地，不会上传。",
      "settings.cancel": "取消",
      "settings.save": "保存并返回",

      "page.overview": "概览",
      "page.sessions": "会话",
      "page.detail": "会话详情",
      "page.settings": "设置",
    },

    en: {
      "lang.switch": "中文",
      "lang.hint": "Switch to Chinese / 切换到中文",

      "nav.aria": "Main navigation",
      "filter.aria": "Global filters",

      "brand.tagline": "Multi-platform AI coding usage analytics",

      "status.connecting": "Connecting",
      "status.refreshing": "Refreshing",
      "status.online": "Updated {0}",
      "status.ready": "Ready",
      "status.initFailed": "Init failed",
      "status.serverDown": "Initialization failed. Make sure the server is running.",
      "status.connFailed": "Connection failed",
      "status.loadFailed": "Failed to load data. Check the server logs and retry.",
      "status.detailLoadFailed": "Failed to load session details.",

      "filter.startDate": "Start date",
      "filter.endDate": "End date",
      "filter.sep": "to",
      "filter.platform": "Platform",
      "filter.project": "Project",
      "filter.model": "Model",
      "filter.allPlatforms": "All platforms",
      "filter.allProjects": "All projects",
      "filter.allModels": "All models",
      "filter.reset": "Reset",
      "filter.sync": "Sync now",

      "sync.scanning": "Scanning logs and importing new records…",
      "sync.complete": "Sync complete: scanned {0} files, updated {1}, imported {2} events, {3} failed.",
      "sync.failed": "Sync failed. Check the server logs.",

      "metric.totalTokens": "Tokens in range",
      "metric.input": "Input tokens",
      "metric.output": "Output tokens",
      "metric.sessions": "Sessions",

      "cache.efficiency": "Cache read rate",
      "cache.read": "Cache read",
      "cache.written": "Cache written",
      "cache.total": "Cache tokens total",

      "chart.trend": "Last 30 days trend",
      "chart.modelShare": "Model share",
      "chart.noData": "No data",
      "chart.tokenValue": "Tokens: {0}",
      "chart.tokensPct": "{0} tokens · {1}%",

      "projects.title": "Project usage",
      "projects.count": "{0} projects",
      "projects.empty": "No project data for current filters",
      "projects.viewSessions": "View sessions for this project",
      "projects.column.project": "Project",
      "projects.column.sessions": "Sessions",
      "projects.column.model": "Main model",
      "projects.column.total": "Total tokens",
      "projects.column.efficiency": "Cache read rate",

      "sessions.title": "Sessions",
      "sessions.records": "{0} records",
      "sessions.pageInfo": "Page {0} / {1}",
      "sessions.empty": "No sessions for current filters",
      "sessions.searchPlaceholder": "Search sessions, projects or models",
      "sessions.perPage20": "20 / page",
      "sessions.perPage50": "50 / page",
      "sessions.perPage100": "100 / page",
      "sessions.export": "Export",
      "sessions.tokensUsed": "{0} tokens used",
      "sessions.modelSep": ", ",
      "sessions.first": "First",
      "sessions.prev": "Prev",
      "sessions.next": "Next",
      "sessions.last": "Last",
      "sessions.jump": "Go",
      "sessions.pagePlaceholder": "Page",
      "sessions.loading": "Loading",
      "sessions.column.sessionId": "Session ID",
      "sessions.column.project": "Project",
      "sessions.column.lastActivity": "Last activity",
      "sessions.column.model": "Model",
      "sessions.column.input": "Input",
      "sessions.column.output": "Output",
      "sessions.column.cacheRead": "Cache read",
      "sessions.column.cacheWrite": "Cache write",
      "sessions.column.total": "Total tokens",
      "sessions.column.platform": "Platform",

      "detail.title": "Session details",
      "detail.back": "Back to sessions",
      "detail.loading": "Loading",
      "detail.missingId": "Missing sessionId parameter.",
      "detail.subtitle": "{0} · {1}",
      "detail.loadingPrompt": "Loading conversation…",
      "detail.promptFailed": "Failed to load conversation.",
      "detail.noText": "(no text content)",
      "detail.emptyEvents": "This session has no events",
      "detail.clickToExpand": "(click to expand and load conversation)",
      "detail.pageInfo": "Page {0} / {1} ({2} events)",
      "detail.summary.events": "Events",
      "detail.summary.total": "Total tokens",
      "detail.summary.input": "Input tokens",
      "detail.summary.output": "Output tokens",
      "detail.summary.cacheRead": "Cache read",
      "detail.h.time": "Time",
      "detail.h.model": "Model",
      "detail.h.input": "Input",
      "detail.h.output": "Output",
      "detail.h.cacheRead": "Cache read",
      "detail.h.cacheWrite": "Cache write",
      "detail.h.total": "Total",

      "seg.text": "Text",
      "seg.thinking": "[thinking]",
      "seg.toolCall": "[tool use: {0}]",
      "seg.toolResult": "[tool result]",
      "seg.toolResultError": "[tool result (error)]",
      "side.userToolResult": "Tool result (tool_result)",
      "side.userMixed": "User input / tool result",
      "side.user": "User input (user_prompt)",
      "side.toolUse": "Tool use (tool_use)",
      "side.assistantMixed": "Assistant reply / tool use",
      "side.assistant": "Assistant reply (assistant_prompt)",

      "settings.title": "Settings",
      "settings.meta": "Stored locally in your browser",
      "settings.refreshInterval": "Refresh interval (seconds)",
      "settings.note": "This tool only reports token usage and session details — no pricing or cost information. Settings are stored in your browser and never uploaded.",
      "settings.cancel": "Cancel",
      "settings.save": "Save & return",

      "page.overview": "Overview",
      "page.sessions": "Sessions",
      "page.detail": "Session details",
      "page.settings": "Settings",
    },
  };

  function detectLang(): "zh" | "en" {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch { /* localStorage 不可用时回退浏览器语言 */ }
    return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  let lang: "zh" | "en" = detectLang();
  const changeHandlers: Array<(next: string) => void> = [];

  function t(key: string, ...args: unknown[]): string {
    const table = dict[lang] as Record<string, string>;
    const zhTable = dict.zh as Record<string, string>;
    let text: string = table[key] ?? zhTable[key] ?? key;
    args.forEach((arg, i) => { text = text.replace(new RegExp("\\{" + i + "\\}", "g"), String(arg)); });
    return text;
  }

  // 应用静态文本：data-i18n（textContent）、data-i18n-placeholder、data-i18n-title（<title>）
  function applyStatic(): void {
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n || ""); });
    document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => { el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder || "")); });
    document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => { document.title = `TokenTracker · ${t(el.dataset.i18nTitle || "")}`; });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    const switcher = document.getElementById("langSwitch");
    if (switcher) {
      switcher.textContent = t("lang.switch");
      switcher.title = t("lang.hint");
      switcher.setAttribute("aria-label", t("lang.hint"));
    }
  }

  function switchLang(next: string): void {
    if (next !== "zh" && next !== "en") return;
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    applyStatic();
    changeHandlers.slice().forEach((fn) => { try { fn(lang); } catch (err) { console.error("lang change handler failed", err); } });
  }

  function onChange(fn: (next: string) => void): void { changeHandlers.push(fn); }
  function getLang(): "zh" | "en" { return lang; }
  function dateTimeLocale(): "zh-CN" | "en-US" { return lang === "zh" ? "zh-CN" : "en-US"; }

  // flatpickr 中文 locale；英文直接返回 undefined，flatpickr 会使用内置英文默认。
  function flatpickrLocale(): FlatpickrLocale | undefined {
    if (lang !== "zh") return undefined;
    return {
      weekdays: { shorthand: ["日", "一", "二", "三", "四", "五", "六"], longhand: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] },
      months: { shorthand: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"], longhand: ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"] },
      rangeSeparator: " 至 ",
      weekAbbreviation: "周",
      scrollTitle: "滚动切换",
      toggleTitle: "点击切换",
      firstDayOfWeek: 1,
    };
  }

  // 顶栏语言切换按钮（script 位于 </body> 前，DOM 已就绪）
  const switcher = document.getElementById("langSwitch");
  if (switcher) switcher.addEventListener("click", () => switchLang(lang === "zh" ? "en" : "zh"));

  window.I18N = { t, switchLang, onChange, applyStatic, getLang, dateTimeLocale, flatpickrLocale, lang, dict };
  applyStatic();
})();
