// 会话详情页：读取 URL 参数，渲染该会话的事件时间线（事件表分页 + 列排序，避免大会话卡顿）。
(function () {
  "use strict";
  const TT = window.TT;
  const I18N = window.I18N;
  const { t, formatTokens, createCell, apiFetch, getPricingParam, toNumber, setConnection, showStatusI18n, hideStatus, initShell } = TT;
  let cachedTimeFormatter: Intl.DateTimeFormat | null = null;
  function getTimeFormatter(): Intl.DateTimeFormat {
    const locale = I18N.dateTimeLocale();
    if (!cachedTimeFormatter || cachedTimeFormatter.resolvedOptions().locale !== locale) {
      cachedTimeFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    }
    return cachedTimeFormatter;
  }

  const el: Record<string, HTMLElement | null> = {
    subtitle: document.getElementById("sessionDetailSubtitle"),
    content: document.getElementById("sessionDetailContent"),
    tableBody: null,
  };

  let currentSessionId = "";
  let currentProjectName = "";
  let promptCache = new Map<string, any>();
  let allEvents: any[] = [];
  let eventPage = 1;
  let eventTotal = 0;
  const EVENT_PAGE_SIZE = 50;
  let eventSort = { field: "timestamp", direction: "asc" };

  const EVENT_HEADERS: Array<{ key: string; labelKey: string; num?: boolean }> = [
    { key: "timestamp", labelKey: "detail.h.time" },
    { key: "model", labelKey: "detail.h.model" },
    { key: "inputTokens", labelKey: "detail.h.input", num: true },
    { key: "outputTokens", labelKey: "detail.h.output", num: true },
    { key: "cacheReadTokens", labelKey: "detail.h.cacheRead", num: true },
    { key: "cacheCreationTokens", labelKey: "detail.h.cacheWrite", num: true },
    { key: "totalTokens", labelKey: "detail.h.total", num: true },
  ];

  function formatTime(value: unknown): string { const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? "--" : getTimeFormatter().format(d); }
  function totalPages(): number { return Math.max(1, Math.ceil(eventTotal / EVENT_PAGE_SIZE)); }

  async function loadDetail(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get("sessionId") || "";
    const projectName = params.get("projectName") || "";
    const platform = params.get("platform") || "claude";
    if (!sessionId) { el.content!.textContent = t("detail.missingId"); return; }
    currentSessionId = sessionId;
    currentProjectName = projectName;
    el.subtitle!.textContent = t("detail.subtitle", projectName, sessionId);
    el.content!.innerHTML = `<p class="loading-text">${t("detail.loading")}</p>`;
    setConnection("", t("status.refreshing"));
    eventSort = { field: "timestamp", direction: "asc" };
    await loadEventPage(1);
    setConnection("online", t("status.online", new Date().toLocaleTimeString(I18N.dateTimeLocale(), { hour12: false })));
  }

  // 超过该长度的块改用「不换行 + 横向滚动」渲染，避免浏览器对超长行断词布局卡死主线程。
  const LARGE_SEGMENT = 5000;

  async function loadEventPage(page: number): Promise<void> {
    const params = new URLSearchParams(location.search);
    const platform = params.get("platform") || "claude";
    const query = new URLSearchParams({
      projectName: currentProjectName,
      platform: platform,
      pricing: getPricingParam(),
      page: String(page),
      pageSize: String(EVENT_PAGE_SIZE),
      sort: eventSort.field,
      direction: eventSort.direction,
    });
    const detail = await apiFetch(`/api/sessions/${encodeURIComponent(currentSessionId)}?${query}`);
    renderDetail(detail);
    el.subtitle!.textContent = t("detail.subtitle", detail.projectDisplayName || currentProjectName, currentSessionId);
  }

  function createSegmentBlock(seg: any): HTMLDivElement {
    let label = t("seg.text");
    let cls = "prompt-seg prompt-text";
    if (seg.kind === "thinking") { label = t("seg.thinking"); cls = "prompt-seg prompt-thinking"; }
    else if (seg.kind === "tool_use") { label = t("seg.toolCall", seg.name || "tool"); cls = "prompt-seg prompt-tool"; }
    else if (seg.kind === "tool_result") { label = seg.isError ? t("seg.toolResultError") : t("seg.toolResult"); cls = "prompt-seg prompt-tool-result" + (seg.isError ? " is-error" : ""); }
    const wrap = document.createElement("div");
    wrap.className = cls;
    const heading = document.createElement("div");
    heading.className = "prompt-seg-label";
    heading.textContent = label;
    const pre = document.createElement("pre");
    const text = seg.text || "";
    pre.className = "prompt-seg-text" + (text.length > LARGE_SEGMENT ? " prompt-seg-text--raw" : "");
    pre.textContent = text;
    wrap.append(heading, pre);
    return wrap;
  }

  function createSection(title: string, segments: any[]): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "prompt-section";
    const titleEl = document.createElement("div");
    titleEl.className = "prompt-section-title";
    titleEl.textContent = title;
    section.appendChild(titleEl);
    if (!segments || !segments.length) {
      const empty = document.createElement("div");
      empty.className = "prompt-seg prompt-text";
      const pre = document.createElement("pre");
      pre.className = "prompt-seg-text";
      pre.textContent = t("detail.noText");
      empty.appendChild(pre);
      section.appendChild(empty);
    } else {
      for (const seg of segments) section.appendChild(createSegmentBlock(seg));
    }
    return section;
  }

  // 按该侧内容构成推断更符合语义的标题：工具返回 / 工具调用 / 用户输入 / 模型回复。
  function sideTitle(role: string, segments: any[]): string {
    const segs = segments || [];
    const hasToolUse = segs.some((s) => s.kind === "tool_use");
    const hasToolResult = segs.some((s) => s.kind === "tool_result");
    const hasText = segs.some((s) => s.kind === "text");
    const hasThinking = segs.some((s) => s.kind === "thinking");
    if (role === "user") {
      if (hasToolResult && !hasText) return t("side.userToolResult");
      if (hasToolResult) return t("side.userMixed");
      return t("side.user");
    }
    if (hasToolUse && !hasText && !hasThinking) return t("side.toolUse");
    if (hasToolUse) return t("side.assistantMixed");
    return t("side.assistant");
  }

  function renderPrompt(cell: HTMLElement, data: any): void {
    cell.replaceChildren(
      createSection(sideTitle("user", data.userSegments), data.userSegments || []),
      createSection(sideTitle("assistant", data.assistantSegments), data.assistantSegments || []),
    );
  }

  async function loadEventPrompt(cell: HTMLElement, event: any): Promise<void> {
    const cached = promptCache.get(event.messageId);
    if (cached) {
      renderPrompt(cell, cached);
      return;
    }
    cell.textContent = t("detail.loadingPrompt");
    try {
      const params = new URLSearchParams(location.search);
      const platform = params.get("platform") || "claude";
      const q = new URLSearchParams({ projectName: currentProjectName, platform: platform, pricing: getPricingParam() });
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/event/${encodeURIComponent(event.messageId)}/prompt?${q}`);
      promptCache.set(event.messageId, data);
      renderPrompt(cell, data);
    } catch (err) {
      console.error(err);
      cell.textContent = t("detail.promptFailed");
    }
  }

  function buildThead(): HTMLTableSectionElement {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const h of EVENT_HEADERS) {
      const th = document.createElement("th");
      th.className = (h.num ? "number " : "") + "sortable";
      th.dataset.sort = h.key;
      const label = document.createElement("span");
      label.textContent = t(h.labelKey);
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.dataset.arrow = h.key;
      th.append(label, arrow);
      th.addEventListener("click", () => onSortHeader(h.key));
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function createPager(): HTMLDivElement {
    const pager = document.createElement("div");
    pager.className = "pagination event-pager";
    const mkBtn = (id: string, text: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "button secondary";
      b.id = id;
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", fn);
      return b;
    };
    const first = mkBtn("eventFirst", t("sessions.first"), () => goPage(1));
    const prev = mkBtn("eventPrev", t("sessions.prev"), () => goPage(eventPage - 1));
    const meta = document.createElement("span");
    meta.className = "page-meta";
    meta.id = "eventPageMeta";
    const next = mkBtn("eventNext", t("sessions.next"), () => goPage(eventPage + 1));
    const last = mkBtn("eventLast", t("sessions.last"), () => goPage(totalPages()));
    const jumpWrap = document.createElement("span");
    jumpWrap.className = "pager-jump";
    const jumpInput = document.createElement("input");
    jumpInput.type = "number";
    jumpInput.min = "1";
    jumpInput.id = "eventJump";
    jumpInput.className = "pager-jump-input";
    jumpInput.placeholder = t("sessions.pagePlaceholder");
    const jumpBtn = mkBtn("eventJumpBtn", t("sessions.jump"), () => {
      const v = parseInt(jumpInput.value, 10);
      if (!Number.isNaN(v)) goPage(v);
    });
    jumpInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = parseInt(jumpInput.value, 10); if (!Number.isNaN(v)) goPage(v); } });
    jumpWrap.append(jumpInput, jumpBtn);
    pager.append(first, prev, meta, next, last, jumpWrap);
    return pager;
  }

  const DEFAULT_EVENT_SORT = { field: "timestamp", direction: "asc" as const };

  function onSortHeader(field: string): void {
    if (eventSort.field === field) {
      // 三态循环：asc → desc → 回到默认排序。
      // 只切 asc/desc 的话，用户永远回不到初始状态（第三次点击又变回 asc）。
      if (eventSort.direction === "asc") {
        eventSort.direction = "desc";
      } else {
        eventSort.field = DEFAULT_EVENT_SORT.field;
        eventSort.direction = DEFAULT_EVENT_SORT.direction;
      }
    } else {
      eventSort.field = field;
      eventSort.direction = field === "timestamp" ? "asc" : "desc";
    }
    loadEventPage(1).catch((error) => console.error("failed to load sorted events", error));
  }

  function goPage(p: number): void {
    const tp = totalPages();
    const nextPage = Math.min(Math.max(1, p | 0), tp);
    loadEventPage(nextPage).catch((error) => console.error("failed to load event page", error));
  }

  function updateSortIndicators(): void {
    document.querySelectorAll<HTMLElement>(".detail-table .sort-arrow").forEach((arrow) => {
      const key = arrow.dataset.arrow;
      arrow.textContent = key === eventSort.field ? (eventSort.direction === "asc" ? "▲" : "▼") : "";
    });
  }

  function setDisabled(id: string, disabled: boolean): void { const e = document.getElementById(id); if (e) (e as HTMLButtonElement).disabled = disabled; }
  function setText(id: string, text: string): void { const e = document.getElementById(id); if (e) e.textContent = text; }

  function renderEventPage(): void {
    const body = el.tableBody as HTMLTableSectionElement;
    body.replaceChildren();
    const slice = allEvents;
    if (!slice.length) {
      const row = document.createElement("tr"); row.className = "empty-row";
      const cell = document.createElement("td"); cell.colSpan = 7; cell.textContent = t("detail.emptyEvents");
      row.appendChild(cell); body.appendChild(row);
    } else {
      for (const event of slice) {
        const row = document.createElement("tr"); row.className = "clickable-row event-row";
        row.append(createCell(formatTime(event.timestamp)), createCell(event.model || "unknown", "model"), createCell(formatTokens(event.inputTokens), "number"), createCell(formatTokens(event.outputTokens), "number"), createCell(formatTokens(event.cacheReadTokens), "number"), createCell(formatTokens(event.cacheCreationTokens), "number"), createCell(formatTokens(event.totalTokens), "number"));
        const detailRow = document.createElement("tr"); detailRow.className = "event-detail-row"; detailRow.hidden = true;
        const detailCell = document.createElement("td"); detailCell.colSpan = 7;
        const placeholder = document.createElement("div");
        placeholder.className = "prompt-empty";
        placeholder.textContent = t("detail.clickToExpand");
        detailCell.appendChild(placeholder);
        detailRow.appendChild(detailCell);
        let loaded = false;
        row.addEventListener("click", () => {
          detailRow.hidden = !detailRow.hidden;
          row.classList.toggle("expanded", !detailRow.hidden);
          if (!detailRow.hidden && !loaded) {
            loaded = true;
            loadEventPrompt(detailCell, event);
          }
        });
        body.append(row, detailRow);
      }
    }
    const tp = totalPages();
    setText("eventPageMeta", t("detail.pageInfo", eventPage, tp, eventTotal));
    setDisabled("eventFirst", eventPage <= 1);
    setDisabled("eventPrev", eventPage <= 1);
    setDisabled("eventNext", eventPage >= tp);
    setDisabled("eventLast", eventPage >= tp);
    const jumpInput = document.getElementById("eventJump");
    if (jumpInput) (jumpInput as HTMLInputElement).max = String(tp);
    updateSortIndicators();
  }

  function renderDetail(detail: any): void {
    allEvents = detail.events || [];
    eventPage = detail.page || 1;
    eventTotal = Number(detail.total ?? detail.eventCount) || 0;
    const summary = document.createElement("div"); summary.className = "detail-summary";
    const items: Array<[string, unknown]> = [[t("detail.summary.events"), detail.eventCount], [t("detail.summary.total"), formatTokens(detail.totalTokens)], [t("detail.summary.input"), formatTokens(detail.inputTokens)], [t("detail.summary.output"), formatTokens(detail.outputTokens)], [t("detail.summary.cacheRead"), formatTokens(detail.cacheReadTokens)]];
    for (const [label, value] of items) { const item = document.createElement("div"); const name = document.createElement("span"); const strong = document.createElement("strong"); name.textContent = label; strong.textContent = String(value); item.append(name, strong); summary.appendChild(item); }
    const tableWrap = document.createElement("div"); tableWrap.className = "table-scroll";
    const table = document.createElement("table"); table.className = "detail-table";
    table.appendChild(buildThead());
    const body = document.createElement("tbody");
    el.tableBody = body;
    table.appendChild(body);
    tableWrap.appendChild(table);
    const pager = createPager();
    el.content!.replaceChildren(summary, tableWrap, pager);
    renderEventPage();
  }

  (async function main() {
    try {
      await initShell({ active: "sessions" });
      hideStatus();
      await loadDetail();
      I18N.onChange(() => loadDetail());
    } catch (error) {
      console.error(error);
      setConnection("error", t("status.initFailed"));
      showStatusI18n("status.detailLoadFailed", [], true);
    }
  })();
})();
