// 会话列表页：搜索、分页、排序、导出。行点击进入会话详情页。
(function () {
  "use strict";
  const TT = window.TT;
  const I18N = window.I18N;
  const { t, formatTokens, abbreviate, createCell, apiFetch, getFilterParams, setConnection, showStatusI18n, hideStatus, loadMetadata, initShell, makeLoader, triggerSyncBackground } = TT;

  const ids = ["sessionTableBody", "tableMeta", "sessionSearch", "pageSize", "exportFormat", "exportButton", "firstPage", "previousPage", "nextPage", "lastPage", "jumpInput", "jumpBtn", "pageMeta"];
  const el: Record<string, HTMLElement | null> = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  let sessions: any[] = [];
  let sessionPage = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
  let sessionSort = { field: "timestamp", direction: "desc" };
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function buildSessionQuery(): URLSearchParams {
    const q = getFilterParams();
    const search = (el.sessionSearch as HTMLInputElement).value.trim();
    if (search) q.set("search", search);
    q.set("page", String(sessionPage.page));
    q.set("pageSize", String(sessionPage.pageSize));
    q.set("sort", sessionSort.field);
    q.set("direction", sessionSort.direction);
    return q;
  }

  function createModelCell(session: any): HTMLTableCellElement {
    const cell = document.createElement("td");
    cell.className = "model";
    const bd = session.modelBreakdown;
    if (Array.isArray(bd) && bd.length > 1) {
      const wrap = document.createElement("span");
      wrap.className = "model-breakdown";
      bd.forEach((m: any, i: number) => {
        if (i > 0) {
          const sep = document.createElement("span");
          sep.className = "model-sep";
          sep.textContent = t("sessions.modelSep");
          wrap.appendChild(sep);
        }
        const chip = document.createElement("span");
        chip.className = "model-chip";
        chip.textContent = m.model;
        chip.title = t("sessions.tokensUsed", formatTokens(m.tokens));
        wrap.appendChild(chip);
      });
      cell.appendChild(wrap);
    } else {
      cell.textContent = session.model || "unknown";
    }
    return cell;
  }

  async function renderSessions(pageData: any): Promise<void> {
    sessions = Array.isArray(pageData.items) ? pageData.items : [];
    sessionPage = { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total, totalPages: pageData.totalPages };
    // 数据变少（同步删除了行、或筛选条件收窄）时，当前页可能越界。
    // 服务端会照常返回空列表，界面就停在「第 5 页 / 共 1 页」且表格为空，只能手动退回。
    if (sessionPage.page > sessionPage.totalPages) {
      sessionPage.page = Math.max(1, sessionPage.totalPages);
      await loadData();
      return;
    }
    const body = el.sessionTableBody as HTMLTableSectionElement;
    body.replaceChildren();
    (el.tableMeta as HTMLElement).textContent = t("sessions.records", formatTokens(sessionPage.total));
    (el.pageMeta as HTMLElement).textContent = t("sessions.pageInfo", sessionPage.page, sessionPage.totalPages);
    (el.previousPage as HTMLButtonElement).disabled = sessionPage.page <= 1;
    (el.nextPage as HTMLButtonElement).disabled = sessionPage.page >= sessionPage.totalPages;
    (el.firstPage as HTMLButtonElement).disabled = sessionPage.page <= 1;
    (el.lastPage as HTMLButtonElement).disabled = sessionPage.page >= sessionPage.totalPages;
    if (el.jumpInput) (el.jumpInput as HTMLInputElement).max = String(sessionPage.totalPages);
    if (!sessions.length) { const row = document.createElement("tr"); row.className = "empty-row"; const cell = createCell(t("sessions.empty")); cell.colSpan = 10; row.appendChild(cell); body.appendChild(row); return; }
    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const row = document.createElement("tr"); row.className = "clickable-row"; row.tabIndex = 0;
      const projectLabel = session.projectDisplayName || session.projectName || "--";
      const projectCell = createCell(projectLabel, "", projectLabel); const project = document.createElement("span"); project.className = "project"; project.textContent = String(projectCell.textContent); projectCell.replaceChildren(project);
      const platform = session.platform || "claude";
      const platformCell = document.createElement("td");
      platformCell.className = "platform-cell";
      const platformBadge = document.createElement("span");
      platformBadge.className = `platform-badge platform-${platform}`;
      platformBadge.textContent = TT.getPlatformLabel(platform);
      platformCell.appendChild(platformBadge);
      row.append(createCell(abbreviate(session.sessionId), "session-id", session.sessionId || ""), projectCell, createCell(formatTimeCell(session.timestamp)), createModelCell(session), createCell(formatTokens(session.inputTokens), "number"), createCell(formatTokens(session.outputTokens), "number"), createCell(formatTokens(session.cacheReadTokens), "number"), createCell(formatTokens(session.cacheCreationTokens), "number"), createCell(formatTokens(session.totalTokens), "number"), platformCell);
      const open = (): void => { location.href = `session.html?sessionId=${encodeURIComponent(session.sessionId)}&projectName=${encodeURIComponent(session.projectName || "")}&platform=${encodeURIComponent(platform)}`; };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
      fragment.appendChild(row);
    }
    body.appendChild(fragment);
    document.querySelectorAll<HTMLElement>("[data-arrow]").forEach((arrow) => { arrow.textContent = arrow.dataset.arrow === sessionSort.field ? (sessionSort.direction === "asc" ? "↑" : "↓") : ""; });
  }

  function formatTimeCell(value: unknown): string { const d = new Date(String(value)); if (Number.isNaN(d.getTime())) return "--"; return new Intl.DateTimeFormat(I18N.dateTimeLocale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d); }

  const loadData = makeLoader(async (isCurrent) => {
    setConnection("", t("status.refreshing"));
    const data = await apiFetch(`/api/sessions?${buildSessionQuery()}`);
    // 渲染前确认仍是最新一次请求：翻页/搜索/排序会连续发起多次请求，
    // 慢的旧响应若照常渲染，表格会退回上一次的条件结果。
    if (!isCurrent()) return;
    await renderSessions(data);
    setConnection("online", t("status.online", new Date().toLocaleTimeString(I18N.dateTimeLocale(), { hour12: false })));
  });

  function exportSessions(): void {
    const q = buildSessionQuery();
    q.delete("page"); q.delete("pageSize"); q.delete("sort"); q.delete("direction");
    q.set("format", (el.exportFormat as HTMLSelectElement).value);
    window.location.assign(`/api/export?${q}`);
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  function restartTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadData, TT.getSettings().refreshIntervalSeconds * 1000);
  }

  (async function main() {
    try {
      await initShell({ active: "sessions", filterBar: true, onChange: () => { sessionPage.page = 1; loadData(); } });
      await loadMetadata();
      const drillParams = new URLSearchParams(location.search);
      const drillProject = drillParams.get("projectName");
      if (drillProject) TT.setFilterValue("projectFilter", drillProject);
      hideStatus();
      await loadData();
      restartTimer();
      triggerSyncBackground(loadData);

      (el.sessionSearch as HTMLInputElement).addEventListener("input", () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(() => { sessionPage.page = 1; loadData(); }, 300); });
      (el.pageSize as HTMLSelectElement).addEventListener("change", () => { sessionPage.pageSize = Number((el.pageSize as HTMLSelectElement).value); sessionPage.page = 1; loadData(); });
      (el.previousPage as HTMLButtonElement).addEventListener("click", () => { if (sessionPage.page > 1) { sessionPage.page -= 1; loadData(); } });
      (el.nextPage as HTMLButtonElement).addEventListener("click", () => { if (sessionPage.page < sessionPage.totalPages) { sessionPage.page += 1; loadData(); } });
      (el.firstPage as HTMLButtonElement).addEventListener("click", () => { if (sessionPage.page > 1) { sessionPage.page = 1; loadData(); } });
      (el.lastPage as HTMLButtonElement).addEventListener("click", () => { if (sessionPage.page < sessionPage.totalPages) { sessionPage.page = sessionPage.totalPages; loadData(); } });
      const jumpTo = (): void => { const v = parseInt((el.jumpInput as HTMLInputElement).value, 10); if (!Number.isNaN(v) && v >= 1 && v <= sessionPage.totalPages) { sessionPage.page = v; loadData(); } };
      (el.jumpBtn as HTMLButtonElement).addEventListener("click", jumpTo);
      (el.jumpInput as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") jumpTo(); });
      document.querySelectorAll<HTMLElement>("[data-sort]").forEach((button) => button.addEventListener("click", () => { const field = button.dataset.sort || ""; sessionSort.direction = sessionSort.field === field && sessionSort.direction === "desc" ? "asc" : "desc"; sessionSort.field = field; sessionPage.page = 1; loadData(); }));
      (el.exportButton as HTMLButtonElement).addEventListener("click", exportSessions);
      I18N.onChange(() => loadData());
    } catch (error) {
      console.error(error);
      setConnection("error", t("status.initFailed"));
      showStatusI18n("status.serverDown", [], true);
    }
  })();
})();
