// 后端共享类型：token 事件、定价、解析结果。纯类型文件，编译后无运行时产物。

export interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationPerMillion: number;
}

/** 定价表：模型前缀 → 定价；`default` 键为 null（表示"无默认价"）。 */
export type PricingTable = Record<string, TokenPricing | null>;

/** 一条 token 用量事件（解析器与数据库行统一转换为该形状）。 */
export interface UsageEvent {
  eventKey: string;
  sourceFile: string;
  messageId: string;
  sessionId: string;
  projectName: string;
  timestamp: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  platform?: string;
}

export interface SessionSummary {
  sessionId: string;
  projectName: string;
  timestamp: string | null;
  model: string | null;
}

/** 解析器输入的日志文件信息。 */
export interface LogFileInfo {
  sessionId: string;
  projectName: string;
  filePath: string;
}

/** 对话原文的结构化分段（按类型渲染为独立标签块）。 */
export interface Segment {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  name?: string;
  isError?: boolean;
}

// ---- Codex 解析相关 ----

/** Codex rollout 文件信息（storedPath 为相对 ~/.codex/sessions 的路径）。 */
export interface CodexLogFileInfo extends LogFileInfo {
  storedPath?: string;
}

/** Codex 解析结果：会话元信息带 cwd，prompts 为每轮对话分段（仅在 withPrompts 时填充）。 */
export interface CodexParsedLog {
  session: SessionSummary & { cwd: string | null };
  events: UsageEvent[];
  invalidLines: number;
  duplicateRecords: number;
  usageRecords: number;
  prompts: Map<string, { userSegments: Segment[]; assistantSegments: Segment[] }>;
}

export interface CodexSessionFileInfo {
  filePath: string;
  storedPath: string;
  modifiedTimeMs: number;
  fileSize: number;
}

export interface ParsedLog {
  session: SessionSummary;
  events: UsageEvent[];
  invalidLines: number;
  usageRecords: number;
  duplicateRecords: number;
}

/** 项目聚合统计（calculateProjectStats 输出 + 成本追加后的形状）。 */
export interface ProjectStat {
  projectName: string;
  sessionCount: number;
  modelDistribution: Array<{ model: string; totalTokens: number }>;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
  complete: boolean;
}

// ---- 数据库相关 ----

export interface EventFilters {
  date?: string;
  startDate?: string;
  endDate?: string;
  model?: string;
  projectName?: string;
  sessionId?: string;
  search?: string;
  platform?: string;
}

export interface Pagination { page: number; pageSize: number; offset: number }

export interface SessionRef { sessionId: string; projectName: string }

export interface SessionRow {
  sessionId: string;
  projectName: string;
  firstTimestamp: string | null;
  timestamp: string | null;
  lastTimestamp: string | null;
  model: string | null;
  platform: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface FilterOptions { projects: string[]; models: string[]; platforms: string[] }

export interface ImportedLogState {
  modifiedTimeMs: number;
  fileSize: number;
  byteOffset: number;
  lastSyncAt: string | null;
  status: string;
  error: string | null;
  platform: string;
}

export interface ImportDiagnostic {
  filePath: string;
  status: string;
  error: string | null;
  lastSyncAt: string | null;
  byteOffset: number;
  fileSize: number;
  platform: string;
}
