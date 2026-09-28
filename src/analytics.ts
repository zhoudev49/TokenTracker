// 聚合统计：项目成本中心、缓存分析、CSV 输出。成本计算委托 pricing。
import { calculateEventCost, getModelPricing } from "./pricing";
import type { ProjectStat, UsageEvent } from "./types";

function eventKey(event: UsageEvent): string {
  return `${event.projectName}\0${event.sessionId}`;
}

interface ProjectAccumulator {
  projectName: string;
  sessionIds: Set<string>;
  models: Map<string, number>;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ProjectStatBase {
  projectName: string;
  sessionCount: number;
  modelDistribution: Array<{ model: string; totalTokens: number }>;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function calculateProjectStats(events: UsageEvent[]): ProjectStatBase[] {
  const projects = new Map<string, ProjectAccumulator>();
  for (const event of events) {
    const name = event.projectName || "unknown";
    if (!projects.has(name)) {
      projects.set(name, {
        projectName: name,
        sessionIds: new Set(),
        models: new Map(),
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    }
    const project = projects.get(name)!;
    project.sessionIds.add(eventKey(event));
    const model = event.model;
    if (model && model !== "unknown" && model !== "<synthetic>" && model !== "") {
      project.models.set(model, (project.models.get(model) || 0) + Number(event.totalTokens || 0));
    }
    project.totalTokens += Number(event.totalTokens || 0);
    project.inputTokens += Number(event.inputTokens || 0);
    project.outputTokens += Number(event.outputTokens || 0);
    project.cacheReadTokens += Number(event.cacheReadTokens || 0);
    project.cacheCreationTokens += Number(event.cacheCreationTokens || 0);
  }
  return Array.from(projects.values()).map((project) => ({
    projectName: project.projectName,
    sessionCount: project.sessionIds.size,
    modelDistribution: Array.from(project.models, ([model, totalTokens]) => ({ model, totalTokens }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    totalTokens: project.totalTokens,
    inputTokens: project.inputTokens,
    outputTokens: project.outputTokens,
    cacheReadTokens: project.cacheReadTokens,
    cacheCreationTokens: project.cacheCreationTokens,
  })).sort((left, right) => right.totalTokens - left.totalTokens);
}

interface CostAccumulator {
  estimatedCostUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  unpricedModels: Set<string>;
}

function addCostsToProjects(projects: ProjectStatBase[], events: UsageEvent[], customPricing: unknown): ProjectStat[] {
  const eventsByProject = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const name = event.projectName || "unknown";
    if (!eventsByProject.has(name)) eventsByProject.set(name, []);
    eventsByProject.get(name)!.push(event);
  }
  return projects.map((project) => {
    const projectEvents = eventsByProject.get(project.projectName) || [];
    const cost = projectEvents.reduce<CostAccumulator>((result, event) => {
      const eventCost = calculateEventCost(event, customPricing);
      if (eventCost.priced) {
        result.estimatedCostUsd += eventCost.costUsd ?? 0;
        result.pricedTokens += Number(event.totalTokens || 0);
      } else {
        result.unpricedTokens += Number(event.totalTokens || 0);
        result.unpricedModels.add(event.model || "unknown");
      }
      return result;
    }, { estimatedCostUsd: 0, pricedTokens: 0, unpricedTokens: 0, unpricedModels: new Set<string>() });
    return {
      ...project,
      estimatedCostUsd: Number(cost.estimatedCostUsd.toFixed(6)),
      pricedTokens: cost.pricedTokens,
      unpricedTokens: cost.unpricedTokens,
      unpricedModels: Array.from(cost.unpricedModels).sort(),
      complete: cost.unpricedTokens === 0,
    };
  });
}

interface CacheGroup {
  projectName: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedSavingsUsd: number;
}

interface CacheTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheableTokens: number;
  cacheEfficiency: number;
  estimatedSavingsUsd: number;
}

function calculateCacheAnalytics(events: UsageEvent[], customPricing: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheableTokens: number;
  cacheEfficiency: number;
  cacheEfficiencyPercent: number;
  estimatedSavingsUsd: number;
  breakdown: Array<{
    projectName: string;
    model: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estimatedSavingsUsd: number;
    cacheEfficiency: number;
  }>;
} {
  const groups = new Map<string, CacheGroup>();
  const totals: CacheTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheableTokens: 0,
    cacheEfficiency: 0,
    estimatedSavingsUsd: 0,
  };
  for (const event of events) {
    const model = event.model || "unknown";
    const projectName = event.projectName || "unknown";
    const key = `${projectName}\0${model}`;
    if (!groups.has(key)) groups.set(key, {
      projectName,
      model,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedSavingsUsd: 0,
    });
    const group = groups.get(key)!;
    const inputTokens = Number(event.inputTokens || 0);
    const cacheReadTokens = Number(event.cacheReadTokens || 0);
    const cacheCreationTokens = Number(event.cacheCreationTokens || 0);
    const pricing = getModelPricing(model, customPricing);
    const savings = pricing
      ? (cacheReadTokens / 1_000_000) * Math.max(0, pricing.inputPerMillion - pricing.cacheReadPerMillion)
      : 0;
    group.inputTokens += inputTokens;
    group.cacheReadTokens += cacheReadTokens;
    group.cacheCreationTokens += cacheCreationTokens;
    group.estimatedSavingsUsd += savings;
    totals.inputTokens += inputTokens;
    totals.outputTokens += Number(event.outputTokens || 0);
    totals.cacheReadTokens += cacheReadTokens;
    totals.cacheCreationTokens += cacheCreationTokens;
    totals.estimatedSavingsUsd += savings;
  }
  totals.cacheableTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  totals.cacheEfficiency = totals.cacheableTokens === 0 ? 0 : totals.cacheReadTokens / totals.cacheableTokens;
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheableTokens: totals.cacheableTokens,
    cacheEfficiency: totals.cacheEfficiency,
    cacheEfficiencyPercent: Number((totals.cacheEfficiency * 100).toFixed(2)),
    estimatedSavingsUsd: Number(totals.estimatedSavingsUsd.toFixed(6)),
    breakdown: Array.from(groups.values()).map((group) => ({
      ...group,
      estimatedSavingsUsd: Number(group.estimatedSavingsUsd.toFixed(6)),
      cacheEfficiency: group.inputTokens + group.cacheReadTokens + group.cacheCreationTokens === 0
        ? 0
        : group.cacheReadTokens / (group.inputTokens + group.cacheReadTokens + group.cacheCreationTokens),
    })).sort((left, right) => right.cacheReadTokens - left.cacheReadTokens),
  };
}

/**
 * 防 CSV 公式注入：单元格以 `=` `+` `@`、制表/回车符开头，或 `-` 之后能构成公式时，
 * 前置一个单引号，让表格软件按文本处理。
 *
 * `-` 必须单独判断。编码后的项目名一律以 `-` 开头
 * （`encodeProjectName("/Users/dev/proj")` → `-Users-dev-proj`），
 * 若把 `-` 与其它前缀一视同仁，**每个 POSIX 用户**导出的项目名都会多一个引号，
 * 该列再也无法分组、透视或与其它表 join。
 *
 * 而 `-Users-dev-proj-app` 并不是可执行的公式：它只有字母与连字符，
 * 既不构成数字运算，也没有 DDE 所需的 `|`/`!`，表格软件只会报 `#NAME?`。
 * 真正危险的形态是：
 *   -2、-2+3      数字表达式
 *   -(1+1)        函数调用
 *   -A1           单元格引用
 *   -cmd|'/c calc'!A1   DDE 命令执行
 * 因此只在命中这几种形态时才加引号。
 */
const CSV_FORMULA_PREFIX = /^[=+@\t\r]/;
/** `-` 后接数字 / 括号 / 单元格引用，或整串含有可执行的运算符与引用符号。 */
const CSV_NEGATIVE_FORMULA = /^-\d/;
const CSV_NEGATIVE_CALL = /^-\s*\(/;
const CSV_CELL_REFERENCE = /^-[A-Za-z]{1,3}\d{1,7}$/;
/** `|` 与 `!` 是 DDE 的特征；其余是算术/字符串运算符。 */
const CSV_EXECUTABLE_CHARS = /[|!()"'=+*/^&%]/;

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const dangerous = CSV_FORMULA_PREFIX.test(text)
    || (text.startsWith("-") && (
      CSV_NEGATIVE_FORMULA.test(text)
      || CSV_NEGATIVE_CALL.test(text)
      || CSV_CELL_REFERENCE.test(text)
      || CSV_EXECUTABLE_CHARS.test(text)
    ));
  const safe = dangerous ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function rowsToCsv(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string }>): string {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export = {
  addCostsToProjects,
  calculateCacheAnalytics,
  calculateProjectStats,
  rowsToCsv,
};
