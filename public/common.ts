// TokenTracker 共享壳层：导航、筛选条、连接/状态、API 封装、可靠的同步+重载。
// 以 classic script 形式加载（编译产物为普通脚本），所有方法挂到 window.TT 供各页面脚本使用。
(function () {
  "use strict";

  const I18N: I18NAPI = window.I18N;
  const t = I18N.t;

  const numberFormatter = new Intl.NumberFormat("zh-CN");
  let cachedTimeFormatter: Intl.DateTimeFormat | null = null;
  function getTimeFormatter(): Intl.DateTimeFormat {
    const locale = I18N.dateTimeLocale();
    if (!cachedTimeFormatter || cachedTimeFormatter.resolvedOptions().locale !== locale) {
      cachedTimeFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    }
    return cachedTimeFormatter;
  }

  const SETTINGS_KEY = "token-tracker-settings-v2";
  const FILTER_KEY = "token-tracker-filters-v1";
  const NAV_ITEMS = [
    { href: "index.html", page: "overview" },
    { href: "sessions.html", page: "sessions" },
    { href: "settings.html", page: "settings" },
  ];

  let settings = loadSettings();
  let filterOptions: { projects: Array<string | { value: string; label: string }>; models: Array<string | { value: string; label: string }> } = { projects: [], models: [] };
  // 平台下拉选项：先给出内置兜底值，启动后用 /api/platforms（后端注册表）覆盖，
  // 因此后端新增一个平台时前端无需改动。
  let platformOptions: Array<{ value: string; label: string }> = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ];

  function getPlatformLabel(platformId: string): string {
    const match = platformOptions.find((item) => item.value === platformId);
    return match ? match.label : (platformId || "Claude Code");
  }

  // 全局 DOM 缓存
  const filterIds = ["startDate", "endDate", "projectFilter", "modelFilter", "platformFilter", "resetFiltersButton", "syncButton"];
  interface FilterEls {
    startDate: HTMLInputElement;
    endDate: HTMLInputElement;
    projectFilter: HTMLSelectElement;
    modelFilter: HTMLSelectElement;
    platformFilter: HTMLSelectElement;
    resetFiltersButton: HTMLButtonElement;
    syncButton: HTMLButtonElement;
  }
  const filterEls = {} as FilterEls;
  // 筛选控件组件实例：{ startDate:{type:'flatpickr',api}, projectFilter:{type:'tomselect',api}, ... }
  type Widget = { type: "flatpickr"; api: FlatpickrInstance } | { type: "tomselect"; api: TomSelectInstance };
  const widgetInstances: Record<string, Widget> = {};
  let elConnectionDot: HTMLElement | null, elConnectionText: HTMLElement | null, elStatusBanner: HTMLElement | null;
  let syncToken = 0;

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
      return {
        refreshIntervalSeconds: Math.min(3600, Math.max(5, Math.trunc(getNonNegative(stored.refreshIntervalSeconds, 30)))),
        // 计价相关配置目前没有界面入口，但后端仍会用它计算成本（当前不在界面展示），
        // 因此继续透传/保留，便于以后需要时恢复。
        modelPricing: stored.modelPricing && typeof stored.modelPricing === "object" ? stored.modelPricing : {},
      };
    } catch {
      return { refreshIntervalSeconds: 30, modelPricing: {} };
    }
  }
  function saveSettings(next: Record<string, unknown>): void { settings = Object.assign({}, settings, next); localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function getSettings(): { refreshIntervalSeconds: number; modelPricing: Record<string, unknown> } { return settings; }

  function toNumber(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  function getNonNegative(value: unknown, fallback: number): number { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }

  function formatTokens(value: unknown): string { return numberFormatter.format(toNumber(value)); }
  function formatPercent(value: unknown): string { return `${toNumber(value).toFixed(2)}%`; }
  function formatTime(value: unknown): string { const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? "--" : getTimeFormatter().format(d); }
  function abbreviate(value: unknown): string { const v = String(value || ""); return v.length <= 16 ? v || "--" : `${v.slice(0, 8)}...${v.slice(-4)}`; }
  function createCell(text: unknown, className = "", title = ""): HTMLTableCellElement { const c = document.createElement("td"); c.textContent = String(text ?? ""); if (className) c.className = className; if (title) c.title = title; return c; }
  function getEl(id: string): HTMLElement | null { return document.getElementById(id); }

  // ---- 筛选状态持久化 ----
  function loadFilterState(): Record<string, string> { try { return JSON.parse(localStorage.getItem(FILTER_KEY) || "{}") || {}; } catch { return {}; } }
  function saveFilterState(state: Record<string, string>): void { localStorage.setItem(FILTER_KEY, JSON.stringify(state)); }
  function setSavedFilter(patch: Record<string, string>): void { const s = loadFilterState(); Object.assign(s, patch); saveFilterState(s); }

  // ---- 导航 ----
  function renderNav(activePage: string): void {
    const nav = getEl("navRoot");
    if (!nav) return;
    nav.className = "mainnav";
    nav.setAttribute("aria-label", t("nav.aria"));
    nav.innerHTML = NAV_ITEMS.map((item) => `<a href="${item.href}" class="nav-link${item.page === activePage ? " active" : ""}">${t(`page.${item.page}`)}</a>`).join("");
  }

  // ---- 筛选条 ----
  function renderFilterBar(onChange: (() => void) | null): void {
    const root = getEl("filterBarRoot");
    if (!root) return;
    root.className = "filter-bar";
    root.setAttribute("aria-label", t("filter.aria"));
    root.innerHTML = `
      <div class="date-range">
        <div class="filter-field">
          <label for="startDate" data-i18n="filter.startDate">开始日期</label>
          <div class="field-control">
            <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            <input id="startDate" type="text" placeholder="开始日期" autocomplete="off" data-i18n-placeholder="filter.startDate" />
          </div>
        </div>
        <span class="date-range-sep" aria-hidden="true" data-i18n="filter.sep">至</span>
        <div class="filter-field">
          <label for="endDate" data-i18n="filter.endDate">结束日期</label>
          <div class="field-control">
            <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            <input id="endDate" type="text" placeholder="结束日期" autocomplete="off" data-i18n-placeholder="filter.endDate" />
          </div>
        </div>
      </div>
      <div class="filter-field filter-wide">
        <label for="platformFilter" data-i18n="filter.platform">平台</label>
        <div class="field-control field-control--select">
          <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          <!-- 首屏占位：真实平台清单由 loadMetadata() 用 /api/platforms 覆盖，这里只需给个合理的兜底 -->
          <select id="platformFilter"><option value="">${t("filter.allPlatforms")}</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
        </div>
      </div>
      <div class="filter-field filter-wide">
        <label for="projectFilter" data-i18n="filter.project">项目</label>
        <div class="field-control field-control--select">
          <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <select id="projectFilter"><option value="">${t("filter.allProjects")}</option></select>
        </div>
      </div>
      <div class="filter-field filter-wide">
        <label for="modelFilter" data-i18n="filter.model">模型</label>
        <div class="field-control field-control--select">
          <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>
          <select id="modelFilter"><option value="">${t("filter.allModels")}</option></select>
        </div>
      </div>
      <div class="filter-actions">
        <button id="resetFiltersButton" class="button ghost" type="button" data-i18n="filter.reset"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/></svg>重置</button>
        <button id="syncButton" class="button primary" type="button" data-i18n="filter.sync"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>立即同步</button>
      </div>`;
    for (const id of filterIds) (filterEls as unknown as Record<string, HTMLElement | null>)[id] = getEl(id);
    I18N.applyStatic();

    const persistAndRun = (): void => {
      setSavedFilter({ startDate: filterEls.startDate.value, endDate: filterEls.endDate.value, projectFilter: filterEls.projectFilter.value, modelFilter: filterEls.modelFilter.value, platformFilter: filterEls.platformFilter.value });
      if (onChange) onChange();
    };

    // 用开源组件替换原生控件：flatpickr（日期）+ Tom Select（下拉）。
    // 自定义暗色浮层彻底消除原生白底弹层；若 CDN 未加载成功则回退原生控件，保证功能可用。
    // locale / altFormat 跟随界面语言：中文显示「2026年8月5日」，英文显示 2026-08-05；
    // 底层值始终为 Y-m-d 供后端。
    // 英文时不传 locale：直接给 locale 赋 undefined 会被 flatpickr 当作
    // 「未知语言名」并打印 "invalid locale undefined" 告警，省略该键才是内置英文默认。
    const initialLocale = I18N.flatpickrLocale();
    const dateConfig: FlatpickrConfig = {
      ...(initialLocale ? { locale: initialLocale } : {}),
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: I18N.getLang() === "zh" ? "Y年n月j日" : "Y-m-d",
      allowInput: true,
      onChange: () => persistAndRun(),
    };
    for (const id of ["startDate", "endDate"] as const) {
      if (typeof window.flatpickr === "function") {
        widgetInstances[id] = { type: "flatpickr", api: window.flatpickr(filterEls[id] as HTMLInputElement, dateConfig) };
      } else {
        (filterEls[id] as HTMLInputElement).addEventListener("change", persistAndRun);
      }
    }
    for (const id of ["projectFilter", "modelFilter", "platformFilter"] as const) {
      if (typeof window.TomSelect === "function") {
        widgetInstances[id] = { type: "tomselect", api: new window.TomSelect(filterEls[id] as HTMLSelectElement, { allowEmptyOption: true, onChange: () => persistAndRun() }) };
      } else {
        (filterEls[id] as HTMLSelectElement).addEventListener("change", persistAndRun);
      }
    }

    const saved = loadFilterState();
    const applyDate = (id: "startDate" | "endDate", value: string): void => {
      const wid = widgetInstances[id];
      if (wid && wid.type === "flatpickr") wid.api.setDate(value, false);
      else (filterEls as unknown as Record<string, HTMLInputElement>)[id].value = value;
    };
    applyDate("startDate", saved.startDate || "");
    applyDate("endDate", saved.endDate || "");

    filterEls.resetFiltersButton.addEventListener("click", () => {
      const clear = (id: string): void => {
        const wid = widgetInstances[id];
        if (wid && wid.type === "flatpickr") wid.api.clear(false);
        // silent=true：清空动作由下方的 setSavedFilter + onChange 统一驱动，
        // 不能让每个控件各自再派发一次 change（会打乱重置顺序，并重复请求数据）。
        else if (wid && wid.type === "tomselect") wid.api.setValue("", true);
        else (filterEls as unknown as Record<string, HTMLSelectElement | HTMLInputElement>)[id].value = "";
      };
      clear("startDate"); clear("endDate"); clear("projectFilter"); clear("modelFilter"); clear("platformFilter");
      setSavedFilter({ startDate: "", endDate: "", projectFilter: "", modelFilter: "", platformFilter: "" });
      if (onChange) onChange();
    });
    filterEls.syncButton.addEventListener("click", () => triggerSync(onChange));

    // 语言切换：更新 flatpickr locale/altFormat 与下拉选项文案（选中值保持不变）
    I18N.onChange(() => {
      const zh = I18N.getLang() === "zh";
      for (const id of ["startDate", "endDate"] as const) {
        const wid = widgetInstances[id];
        if (wid && wid.type === "flatpickr") {
          // 切换回英文时传内置的 "default"（flatpickr 自带的英文 locale），
          // 而不是 undefined —— 后者同样会触发 invalid locale 告警。
          wid.api.set("locale", I18N.flatpickrLocale() || "default");
          wid.api.set("altFormat", zh ? "Y年n月j日" : "Y-m-d");
          const alt = wid.api.altInput;
          if (alt) alt.placeholder = t(id === "startDate" ? "filter.startDate" : "filter.endDate");
        }
      }
      refreshFilterTexts();
    });
  }

  // 语言切换后按当前语言重填下拉选项（含「全部 X」文案），并保留选中值。
  function refreshFilterTexts(): void {
    populateSelect(filterEls.platformFilter, platformOptions, t("filter.allPlatforms"));
    populateSelect(filterEls.projectFilter, filterOptions.projects || [], t("filter.allProjects"));
    const realModels = (filterOptions.models || []).filter((m) => {
      const name = m && typeof m === "object" ? m.value : m;
      return name && name !== "<synthetic>";
    });
    populateSelect(filterEls.modelFilter, realModels, t("filter.allModels"));
  }

  /**
   * 判断某个值在控件里是否真实存在。
   *
   * TomSelect 只把**已选中**的选项同步回原生 <select>，其余选项只存在于它的内部
   * store（`api.options`）里。因此原生 `el.options` 在 TomSelect 场景下几乎是空的
   * （实测：加了 3 个选项后原生 select 仍是 0 个 option），用它做存在性判断会永远
   * 返回 false —— 概览页点项目下钻（`sessions.html?projectName=X`）时参数被静默丢弃，
   * 结果列出全部会话而不是该项目。
   */
  function hasOption(id: string, el: HTMLSelectElement, value: string): boolean {
    const wid = widgetInstances[id];
    if (wid && wid.type === "tomselect") {
      return Object.prototype.hasOwnProperty.call(wid.api.options, value);
    }
    return Array.from(el.options).some((o) => o.value === value);
  }

  function setFilterValue(id: string, value: string): boolean {
    const el = (filterEls as unknown as Record<string, HTMLSelectElement>)[id];
    if (!el || value == null) return false;
    if (!hasOption(id, el, value)) return false;
    el.value = value;
    const wid = widgetInstances[id];
    // 第二个参数是 silent，必须传 true。传 false 会派发 change 事件，
    // 而 populateSelect 是在控件绑定 onchange 之后才被调用的，于是这次程序化赋值会触发
    // persistAndRun() → 把正在重建、尚未填好的控件状态写回 localStorage，
    // 导致用户保存的筛选条件每次刷新页面都被清空。
    if (wid && wid.type === "tomselect") wid.api.setValue(value, true);
    else if (wid && wid.type === "flatpickr") wid.api.setDate(value || "", false);
    return true;
  }

  function clearProjectFilter(): void {
    const saved = loadFilterState();
    if (saved.projectFilter) { delete saved.projectFilter; saveFilterState(saved); }
    const el = filterEls.projectFilter;
    if (!el) return;
    el.value = "";
    const wid = widgetInstances.projectFilter;
    if (wid && wid.type === "tomselect") wid.api.setValue("", true);
  }

  function populateSelect(select: HTMLSelectElement, values: Array<string | { value: string; label: string }>, allLabel: string): void {
    const wid = widgetInstances[select.id];
    const current = select.value;
    if (wid && wid.type === "tomselect") {
      wid.api.clear(true);
      wid.api.clearOptions();
      wid.api.addOption({ value: "", text: allLabel });
      for (const value of values) {
        if (value && typeof value === "object") wid.api.addOption({ value: value.value, text: value.label });
        else wid.api.addOption({ value: String(value), text: String(value) });
      }
      const match = (v: string | { value: string; label: string }): boolean => (v && typeof v === "object" ? v.value : String(v)) === current;
      // silent=true：这里是程序化重建选项，绝不能触发 onchange（否则会把
      // 尚未填好的状态写回 localStorage，覆盖用户保存的筛选条件）。
      wid.api.setValue(values.some(match) ? current : "", true);
      return;
    }
    select.replaceChildren(new Option(allLabel, ""));
    for (const value of values) {
      if (value && typeof value === "object") select.appendChild(new Option(value.label, value.value));
      else select.appendChild(new Option(String(value), String(value)));
    }
    const match = (v: string | { value: string; label: string }): boolean => (v && typeof v === "object" ? v.value : String(v)) === current;
    select.value = values.some(match) ? current : "";
  }

  async function loadMetadata(): Promise<void> {
    const [filters, platforms] = await Promise.all([
      apiFetch("/api/filters"),
      apiFetch("/api/platforms").catch(() => null),
    ]);
    filterOptions = filters;

    // 平台清单来自后端注册表：只展示「本机已安装」或「库里已有数据」的平台，
    // 再兜底补上库中出现但注册表未登记的值（例如旧版本写入的平台标识）。
    const recorded = new Set<string>(Array.isArray(filters.platforms) ? filters.platforms : []);
    const items = platforms && Array.isArray(platforms.items) ? platforms.items : null;
    if (items) {
      platformOptions = (items as Array<{ id: string; label: string; available: boolean }>)
        .filter((item) => item && item.id && (item.available || recorded.has(item.id)))
        .map((item) => ({ value: item.id, label: item.label || item.id }));
    }
    for (const id of recorded) {
      if (!platformOptions.some((option) => option.value === id)) platformOptions.push({ value: id, label: id });
    }
    if (filterEls.platformFilter) populateSelect(filterEls.platformFilter, platformOptions, t("filter.allPlatforms"));

    if (filterEls.projectFilter) populateSelect(filterEls.projectFilter, filters.projects || [], t("filter.allProjects"));
    if (filterEls.modelFilter) {
      const realModels = (filters.models || []).filter((m: string | { value: string }) => {
        const name = m && typeof m === "object" ? m.value : m;
        return name && name !== "<synthetic>";
      });
      populateSelect(filterEls.modelFilter, realModels, t("filter.allModels"));
    }
    const saved = loadFilterState();
    if (saved.projectFilter) setFilterValue("projectFilter", saved.projectFilter);
    if (saved.modelFilter) setFilterValue("modelFilter", saved.modelFilter);
    if (saved.platformFilter) setFilterValue("platformFilter", saved.platformFilter);
  }

  // ---- 查询参数 ----
  function getFilterParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (filterEls.startDate && filterEls.startDate.value) p.set("startDate", filterEls.startDate.value);
    if (filterEls.endDate && filterEls.endDate.value) p.set("endDate", filterEls.endDate.value);
    if (filterEls.platformFilter && filterEls.platformFilter.value) p.set("platform", filterEls.platformFilter.value);
    if (filterEls.projectFilter && filterEls.projectFilter.value) p.set("projectName", filterEls.projectFilter.value);
    if (filterEls.modelFilter && filterEls.modelFilter.value) p.set("model", filterEls.modelFilter.value);
    p.set("pricing", JSON.stringify(settings.modelPricing || {}));
    return p;
  }
  function getPricingParam(): string { return JSON.stringify(settings.modelPricing || {}); }
  function getFilterOptions(): { projects: Array<string | { value: string; label: string }>; models: Array<string | { value: string; label: string }>; platforms: Array<{ value: string; label: string }> } { return { ...filterOptions, platforms: platformOptions }; }

  // ---- 连接/状态 ----
  function setConnection(state: string, text: string): void { if (elConnectionDot) elConnectionDot.className = `connection-dot ${state}`; if (elConnectionText) elConnectionText.textContent = text; }
  function showStatus(message: string, isError = false): void { if (!elStatusBanner) return; elStatusBanner.textContent = message; elStatusBanner.className = isError ? "alert-banner" : "status-banner"; elStatusBanner.hidden = false; }
  // 记录最后一条状态消息的翻译键与参数，语言切换时用当前语言重译横幅。
  let lastStatus: { key: string; args: unknown[]; isError: boolean } | null = null;
  function showStatusI18n(key: string, args: unknown[] = [], isError = false): void {
    lastStatus = { key, args, isError };
    showStatus(t(key, ...args), isError);
  }
  function hideStatus(): void { if (elStatusBanner) elStatusBanner.hidden = true; }

  // ---- API ----
  async function apiFetch(url: string): Promise<any> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`);
    return res.json();
  }

  // ---- 同步：可靠地触发并强制重载当前页数据 ----
  // 用自增 token 保证「最新一次同步」的重载一定执行，不会被并发的定时器重载吞掉。
  async function runSync({ onComplete, silent = false }: { onComplete?: () => Promise<void>; silent?: boolean } = {}): Promise<void> {
    const token = ++syncToken;
    const syncBtn = filterEls.syncButton;
    if (syncBtn) syncBtn.classList.add("is-syncing");
    try {
      try {
        if (!silent) showStatusI18n("sync.scanning");
        const platform = filterEls.platformFilter ? filterEls.platformFilter.value : "";
        const body = platform ? JSON.stringify({ platform }) : "{}";
        const res = await fetch("/api/sync", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body });
        if (!res.ok) throw new Error("sync failed");
        const r = await res.json();
        showStatusI18n("sync.complete", [r.scannedFiles, r.updatedFiles, r.importedEvents, r.failedFiles]);
        if (onComplete && token === syncToken) await onComplete();
      } catch (err) {
        console.error(err);
        showStatusI18n("sync.failed", [], true);
      }
    } finally {
      if (syncBtn) syncBtn.classList.remove("is-syncing");
    }
  }
  function triggerSync(onChange?: (() => void) | null): Promise<void> { return runSync({ onComplete: onChange ? () => Promise.resolve(onChange()) : undefined, silent: false }); }
  function triggerSyncBackground(onChange?: (() => void) | null): Promise<void> { return runSync({ onComplete: onChange ? () => Promise.resolve(onChange()) : undefined, silent: true }); }

  // 生成一个带「序列令牌」的加载器：多次并发调用时，只有最后一次会真正渲染。
  /**
   * 串行化并丢弃过期结果。
   *
   * 注意：`renderFn` 内部同时做了 fetch **和** 渲染，因此「完成后判断 seq」是没用的
   * —— 过期的慢响应早已把 DOM 覆盖成旧数据了。这里把「是否仍是最新一次调用」
   * 通过 `isCurrent` 传给 renderFn，让调用方在执行**渲染之前**自行检查。
   * 同时仍保留 await 后的检查，用于丢弃过期调用产生的错误提示。
   */
  function makeLoader(renderFn: (isCurrent: () => boolean, ...args: any[]) => Promise<any>): (...args: any[]) => Promise<any> {
    let token = 0;
    return async function (...args: any[]): Promise<any> {
      const seq = ++token;
      const isCurrent = (): boolean => seq === token;
      try {
        const data = await renderFn.apply(null, [isCurrent, ...args]);
        if (isCurrent()) return data;
      } catch (err) {
        // 过期调用的报错不应覆盖新调用的状态
        if (isCurrent()) { console.error(err); setConnection("error", t("status.connFailed")); showStatusI18n("status.loadFailed", [], true); }
      }
    };
  }

  function ensureGlobalEls(): void {
    elConnectionDot = getEl("connectionDot");
    elConnectionText = getEl("connectionText");
    elStatusBanner = getEl("statusBanner");
  }

  async function initShell(options: { active: string; filterBar?: boolean; onChange?: (() => void) | null }): Promise<void> {
    const { active, filterBar = false, onChange = null } = options;
    ensureGlobalEls();
    renderNav(active);
    if (filterBar) renderFilterBar(onChange);
    setConnection("", t("status.connecting"));
    // 语言切换：刷新导航文字与状态横幅（最后一条消息用当前语言重译）
    I18N.onChange(() => {
      renderNav(active);
      if (lastStatus && elStatusBanner && !elStatusBanner.hidden) {
        showStatus(t(lastStatus.key, ...lastStatus.args), lastStatus.isError);
      }
      // 连接失败等一次性状态文字也随语言重译
      if (elConnectionDot && elConnectionDot.classList.contains("error")) {
        setConnection("error", t("status.connFailed"));
      }
    });
  }

  // 暴露公共 API
  window.TT = {
    loadSettings, saveSettings, getSettings,
    toNumber, getNonNegative,
    formatTokens, formatPercent, formatTime, abbreviate, createCell,
    t,
    loadFilterState, saveFilterState, setSavedFilter,
    renderNav, renderFilterBar, initShell,
    loadMetadata, populateSelect,
    getFilterParams, getPricingParam, getFilterOptions,
    setConnection, showStatus, showStatusI18n, hideStatus,
    apiFetch, runSync, triggerSync, triggerSyncBackground, makeLoader,
    setFilterValue, clearProjectFilter,
    getPlatformLabel,
  };
})();
