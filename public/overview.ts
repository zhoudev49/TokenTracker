// 概览页：Token 指标卡、缓存条、图表、项目用量。点击项目跳转到会话页并预置筛选。
// 本页只展示 token 数量，不做任何价格 / 成本换算。
(function () {
  "use strict";
  const TT = window.TT;
  const I18N = window.I18N;
  const { t, formatTokens, formatPercent, toNumber, createCell, apiFetch, getFilterParams, setConnection, showStatusI18n, hideStatus, loadMetadata, initShell, makeLoader, triggerSyncBackground } = TT;

  const ids = ["totalTokens", "inputTokens", "outputTokens", "sessionCount", "cacheEfficiency", "cacheReadTokens", "cacheCreationTokens", "cacheTotalTokens", "projectTableBody", "projectMeta"];
  const el: Record<string, HTMLElement | null> = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  let trendChart: ChartInstance | null = null;
  let modelChart: ChartInstance | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function renderOverview(summary: any, cache: any): void {
    (el.totalTokens as HTMLElement).textContent = formatTokens(summary.totalTokens);
    (el.inputTokens as HTMLElement).textContent = formatTokens(summary.inputTokens);
    (el.outputTokens as HTMLElement).textContent = formatTokens(summary.outputTokens);
    (el.sessionCount as HTMLElement).textContent = formatTokens(summary.sessionCount);
    (el.cacheEfficiency as HTMLElement).textContent = formatPercent(cache.cacheEfficiencyPercent);
    (el.cacheReadTokens as HTMLElement).textContent = formatTokens(cache.cacheReadTokens);
    (el.cacheCreationTokens as HTMLElement).textContent = formatTokens(cache.cacheCreationTokens);
    const cacheTotal = toNumber(cache.cacheReadTokens) + toNumber(cache.cacheCreationTokens);
    (el.cacheTotalTokens as HTMLElement).textContent = formatTokens(cacheTotal);
  }

  function renderProjects(data: any): void {
    const all = Array.isArray(data.items) ? data.items : [];
    const projects = all.filter((project: any) => toNumber(project.totalTokens) > 0);
    (el.projectMeta as HTMLElement).textContent = t("projects.count", projects.length);
    const body = el.projectTableBody as HTMLTableSectionElement;
    body.replaceChildren();
    if (!projects.length) { const row = document.createElement("tr"); row.className = "empty-row"; const cell = createCell(t("projects.empty")); cell.colSpan = 7; row.appendChild(cell); body.appendChild(row); return; }
    const fragment = document.createDocumentFragment();
    for (const project of projects) {
      const denominator = project.inputTokens + project.cacheReadTokens + project.cacheCreationTokens;
      const efficiency = denominator ? project.cacheReadTokens / denominator * 100 : 0;
      const row = document.createElement("tr"); row.className = "clickable-row"; row.title = t("projects.viewSessions");
      const projectLabel = project.projectDisplayName || project.projectName;
      row.append(
        createCell(projectLabel, "project-name-cell", projectLabel),
        createCell(formatTokens(project.sessionCount), "number"),
        createCell((project.modelDistribution || []).slice(0, 2).map((item: any) => item.model).join(", ") || "--", "model"),
        createCell(formatTokens(project.inputTokens), "number"),
        createCell(formatTokens(project.outputTokens), "number"),
        createCell(formatTokens(project.totalTokens), "number"),
        createCell(formatPercent(efficiency), "number"),
      );
      row.addEventListener("click", () => { location.href = `sessions.html?projectName=${encodeURIComponent(project.projectName)}`; });
      fragment.appendChild(row);
    }
    body.appendChild(fragment);
  }

  function renderTrendChart(data: any[]): void {
    const labels = data.map((item) => item.date.slice(5));
    const values = data.map((item) => toNumber(item.totalTokens));
    if (!trendChart) {
      trendChart = new Chart(document.getElementById("trendChart"), { type: "line", data: { labels, datasets: [{ data: values, borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,.18)", borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: "index" }, plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { label: (context: any) => t("chart.tokenValue", formatTokens(context.raw)) } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } }, y: { beginAtZero: true, ticks: { callback: formatTokens } } } } });
      return;
    }
    trendChart.data.labels = labels; trendChart.data.datasets[0].data = values;
    // tooltip 文案随语言刷新（callbacks 在创建时绑定，需同步更新）
    if (trendChart.options.plugins && trendChart.options.plugins.tooltip && trendChart.options.plugins.tooltip.callbacks) {
      trendChart.options.plugins.tooltip.callbacks.label = (context: any) => t("chart.tokenValue", formatTokens(context.raw));
    }
    trendChart.update();
  }

  function renderModelChart(distribution: any[]): void {
    const hasData = distribution.length > 0;
    const data = hasData ? distribution : [{ model: t("chart.noData"), totalTokens: 1, percentage: 0 }];
    const palette = ["#3B82F6", "#46bd7e", "#e8aa3c", "#60A5FA", "#e36b6b", "#9c84c5", "#8d99a8"];
    const labels = data.map((item) => item.model);
    const values = data.map((item) => toNumber(item.totalTokens));
    const colors = data.map((_: any, index: number) => (hasData ? palette[index % palette.length] : "#3a4656"));
    if (!modelChart) {
      modelChart = new Chart(document.getElementById("modelChart"), { type: "doughnut", data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#0e131c", borderWidth: 2, hoverOffset: 4 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, pointStyle: "rect" } }, tooltip: { enabled: hasData, callbacks: { label: (context: any) => t("chart.tokensPct", formatTokens(distribution[context.dataIndex].totalTokens), distribution[context.dataIndex].percentage) } } } } });
      return;
    }
    modelChart.data.labels = labels; modelChart.data.datasets[0].data = values; modelChart.data.datasets[0].backgroundColor = colors;
    // tooltip 文案随语言刷新
    if (modelChart.options.plugins && modelChart.options.plugins.tooltip && modelChart.options.plugins.tooltip.callbacks) {
      modelChart.options.plugins.tooltip.callbacks.label = (context: any) => t("chart.tokensPct", formatTokens(distribution[context.dataIndex].totalTokens), distribution[context.dataIndex].percentage);
    }
    modelChart.options.plugins.tooltip.enabled = hasData; modelChart.update();
  }

  const loadData = makeLoader(async (isCurrent) => {
    setConnection("", t("status.refreshing"));
    const baseQuery = getFilterParams();
    const [summary, projects, cache] = await Promise.all([
      apiFetch(`/api/summary?${baseQuery}`),
      apiFetch(`/api/projects?${baseQuery}`),
      apiFetch(`/api/cache-efficiency?${baseQuery}`),
    ]);
    // 渲染前确认这次请求仍是最新一次：轮询与筛选切换会让旧请求晚于新请求返回，
    // 不丢弃就会用陈旧数据覆盖刚渲染好的界面。
    if (!isCurrent()) return;
    renderOverview(summary, cache);
    renderProjects(projects);
    renderTrendChart(summary.dailyTrend || []);
    renderModelChart(summary.modelDistribution || []);
    setConnection("online", t("status.online", new Date().toLocaleTimeString(I18N.dateTimeLocale(), { hour12: false })));
  });

  function restartTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadData, TT.getSettings().refreshIntervalSeconds * 1000);
  }

  (async function main() {
    try {
      await initShell({ active: "overview", filterBar: true, onChange: () => loadData() });
      await loadMetadata();
      TT.clearProjectFilter();
      hideStatus();
      await loadData();
      restartTimer();
      triggerSyncBackground(loadData);
      I18N.onChange(() => loadData());
    } catch (error) {
      console.error(error);
      setConnection("error", t("status.initFailed"));
      showStatusI18n("status.serverDown", [], true);
    }
  })();
})();
