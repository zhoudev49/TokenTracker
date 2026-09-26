// 「Claude 形态」JSONL 日志的通用解析器。
//
// 一批国产/第三方 CLI（WorkBuddy、CodeBuddy Code、Qoder CLI、Qwen Code …）都沿用了
// Claude Code 的会话日志骨架：一行一条 JSON，会话 id / cwd 在顶层，
// token 用量挂在 `message.usage` 上。但各家在三点上并不完全一致，本解析器逐一对齐：
//
// 1. **时间戳**：Claude 用 ISO 字符串，WorkBuddy / CodeBuddy 用毫秒整数 → normalizeTimestamp 兼容两者。
// 2. **模型名**：Claude 在 `message.model`，WorkBuddy 在 `providerData.model` → 按优先级回退取值。
// 3. **输入口径（最容易算错的一点）**：Anthropic 的 `input_tokens` 不含缓存读写，
//    而 OpenAI 系的 `prompt_tokens` **已经包含** cached token。判定方法看 `total_tokens`：
//    若 `total_tokens === input_tokens + output_tokens`，说明上报方按「含缓存」口径统计输入，
//    此时必须减去 `cache_read_input_tokens` 与 `cache_creation_input_tokens`，
//    才能保证入库的四项（纯输入 / 输出 / 缓存读 / 缓存写）相加等于总量。
//    （已用本机 2856 条 WorkBuddy 真实记录验证：prompt_tokens == input_tokens、
//    prompt_cache_hit + prompt_cache_miss == input_tokens，含缓存口径 2856/2856 成立。）
//
// 去重：同一 `message.id` 可能被重复上报（快照更新），以最后一次为准，
// 与 Claude 侧 `log-parser.ts` 的语义保持一致。

import { extractSegments } from "./log-parser";
import {
  normalizeTimestamp,
  toTokenCount,
  type IncrementalParser,
  type ParsedPlatformLog,
  type ParseOptions,
  type PlatformFileInfo,
  type PromptSegments,
} from "./platform-adapter";
import type { Segment, SessionSummary, UsageEvent } from "./types";

const MAX_SEGMENT_CHARS = 20000;

interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): { value: number; found: boolean } {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return { value: toTokenCount(value), found: true };
  }
  return { value: 0, found: false };
}

/** 把任意平台的 usage 对象归一为「四项相加 = 总量」的口径。 */
export function readUsageSnapshot(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const source = usage as Record<string, unknown>;

  const rawInput = pickNumber(source, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const output = pickNumber(source, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const cacheRead = pickNumber(source, [
    "cache_read_input_tokens", "cacheReadInputTokens", "cache_read_tokens", "cacheReadTokens",
    "cached_input_tokens", "cachedTokens", "prompt_cache_hit_tokens",
  ]);
  const cacheCreation = pickNumber(source, [
    "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_creation_tokens", "cacheCreationTokens",
    "cache_write_input_tokens", "cacheWriteTokens", "prompt_cache_write_tokens",
  ]);
  const reportedTotal = pickNumber(source, ["total_tokens", "totalTokens"]);

  if (!rawInput.found && !output.found && !cacheRead.found && !cacheCreation.found && !reportedTotal.found) {
    return null;
  }

  // 输入是否已含缓存：上报总量恰为「输入 + 输出」即视为含缓存口径。
  const inputIncludesCache = reportedTotal.value > 0 && reportedTotal.value === rawInput.value + output.value;
  const inputTokens = inputIncludesCache
    ? Math.max(0, rawInput.value - cacheRead.value - cacheCreation.value)
    : rawInput.value;

  return {
    inputTokens,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheCreationTokens: cacheCreation.value,
    totalTokens: inputTokens + output.value + cacheRead.value + cacheCreation.value,
  };
}

/** 从 `inputTokensDetails: [{ cached_tokens }]` 之类的明细里补出缓存读计数。 */
function readCacheReadFromDetails(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  const details = usage.inputTokensDetails ?? usage.input_tokens_details ?? usage.prompt_tokens_details;
  const list = Array.isArray(details) ? details : details ? [details] : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const cached = pickNumber(item as Record<string, unknown>, ["cached_tokens", "cachedTokens"]);
    if (cached.found) return cached.value;
  }
  return 0;
}

/** 取记录里第一个可用的 usage 对象，按各家优先级回退。 */
function pickUsage(record: Record<string, unknown>, extraUsage?: (record: Record<string, unknown>) => unknown): NormalizedUsage | null {
  const message = asRecord(record.message);
  const providerData = asRecord(record.providerData);
  const response = asRecord(record.response);

  const candidates: unknown[] = [
    message ? message.usage : null,
    record.usage,
    providerData ? providerData.rawUsage : null,
    providerData ? providerData.usage : null,
    response ? response.usage : null,
    // 少数平台把用量放在自定义字段里（如 Qoder 的 model.response.completed 事件在 data 上）。
    extraUsage ? extraUsage(record) : null,
  ];

  for (const candidate of candidates) {
    const normalized = readUsageSnapshot(candidate);
    if (!normalized) continue;

    // total_tokens 缺失时缓存读可能只藏在 *_details 里，这里补一次。
    if (normalized.cacheReadTokens === 0) {
      const detailCacheRead = readCacheReadFromDetails(asRecord(candidate));
      if (detailCacheRead > 0) {
        const raw = asRecord(candidate);
        const rawInput = raw ? pickNumber(raw, ["input_tokens", "inputTokens", "prompt_tokens"]).value : 0;
        const output = raw ? pickNumber(raw, ["output_tokens", "outputTokens", "completion_tokens"]).value : 0;
        const reportedTotal = raw ? pickNumber(raw, ["total_tokens", "totalTokens"]).value : 0;
        const includesCache = reportedTotal > 0 && reportedTotal === rawInput + output;
        const inputTokens = includesCache
          ? Math.max(0, rawInput - detailCacheRead - normalized.cacheCreationTokens)
          : normalized.inputTokens;
        return {
          ...normalized,
          inputTokens,
          cacheReadTokens: detailCacheRead,
          totalTokens: inputTokens + normalized.outputTokens + detailCacheRead + normalized.cacheCreationTokens,
        };
      }
    }
    return normalized;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function capSegments(segments: Segment[]): Segment[] {
  return segments
    .filter((segment) => segment.text && segment.text.trim())
    .map((segment) => ({
      ...segment,
      text: segment.text.length > MAX_SEGMENT_CHARS
        ? `${segment.text.slice(0, MAX_SEGMENT_CHARS)}\n\n…（内容过长已截断，完整内容见原始日志）`
        : segment.text,
    }));
}

function formatToolArguments(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/** 判断一条记录是否表达「用户发言」（含工具结果回灌）。 */
function isUserRecord(record: Record<string, unknown>, message: Record<string, unknown> | null): boolean {
  const role = (message ? message.role : undefined) ?? record.role;
  return role === "user";
}

function isAssistantRecord(record: Record<string, unknown>, message: Record<string, unknown> | null): boolean {
  const role = (message ? message.role : undefined) ?? record.role;
  return role === "assistant";
}

export interface ClaudeJsonlParseOptions extends ParseOptions {
  /** 记录里的 usage 不在常规位置时，允许调用方额外提供一个候选（如 Qoder 的 data 字段）。 */
  extraUsageFromRecord?: (record: Record<string, unknown>) => unknown;
}

/**
 * 创建一个流式解析器。同一份代码同时服务于「整份重建」与「按偏移增量续读」：
 * 增量续读时把新行继续喂进同一个实例即可（事件按 id 去重，重复喂入是幂等的）。
 */
export function createClaudeJsonlParser(
  file: PlatformFileInfo,
  platformId: string,
  options: ClaudeJsonlParseOptions = {},
): IncrementalParser {
  const withPrompts = options.withPrompts === true;
  const eventsByKey = new Map<string, UsageEvent>();
  const prompts = new Map<string, PromptSegments>();

  const session: SessionSummary = {
    sessionId: file.sessionId,
    projectName: file.projectName,
    timestamp: null,
    model: null,
  };

  let invalidLines = 0;
  let usageRecords = 0;
  let skippedZeroRecords = 0;
  let lastUserBlocks: unknown = null;
  let pendingAssistant: Segment[] = [];
  let lastAssistantText = "";

  function pushAssistantText(text: string): void {
    if (!text || !text.trim()) return;
    if (text === lastAssistantText) return; // 同一段正文在快照更新里会重复出现
    lastAssistantText = text;
    pendingAssistant.push({ kind: "text", text });
  }

  function addLine(line: string): void {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines += 1;
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    const message = asRecord(record.message);
    const providerData = asRecord(record.providerData);

    const recordSessionId = pickString(record, ["sessionId", "session_id"]);
    if (recordSessionId) session.sessionId = recordSessionId;

    const timestamp = normalizeTimestamp(record.timestamp ?? record.createdAt ?? record.time);
    if (timestamp && (!session.timestamp || timestamp < session.timestamp)) session.timestamp = timestamp;

    const model = pickString(message, ["model"])
      || pickString(providerData, ["model", "requestModelId", "requestModelName"])
      || pickString(record, ["model"]);
    if (model && !session.model) session.model = model;

    const recordType = typeof record.type === "string" ? record.type : "";

    if (withPrompts) {
      if (isUserRecord(record, message)) {
        lastUserBlocks = message ? message.content : record.content;
        lastAssistantText = "";
        pendingAssistant = [];
      } else if (recordType === "function_call_result" || recordType === "custom_tool_call_result") {
        const output = record.output ?? (message ? message.content : null) ?? record.content;
        const text = typeof output === "string" ? output : formatToolArguments(output);
        const blocks = Array.isArray(lastUserBlocks) ? lastUserBlocks : lastUserBlocks ? [{ type: "text", text: String(lastUserBlocks) }] : [];
        blocks.push({ type: "tool_result", content: text, is_error: /^Exit code: [1-9]/.test(text) });
        lastUserBlocks = blocks;
      } else if (recordType === "reasoning") {
        const thinking = pickString(providerData, ["reasoning"]) || pickString(message, ["content"]) || pickString(record, ["content"]);
        if (thinking) pendingAssistant.push({ kind: "thinking", text: thinking });
      } else if (recordType === "function_call" || recordType === "custom_tool_call") {
        // WorkBuddy 把思考内容直接挂在 function_call 的 providerData.reasoning 上
        const thinking = pickString(providerData, ["reasoning"]);
        if (thinking) pendingAssistant.push({ kind: "thinking", text: thinking });
        pendingAssistant.push({
          kind: "tool_use",
          name: pickString(record, ["name"]) || "tool",
          text: formatToolArguments(record.arguments ?? record.input),
        });
      } else if (isAssistantRecord(record, message)) {
        const content = message ? message.content : record.content;
        for (const segment of extractSegments(content)) {
          if (segment.kind === "text") pushAssistantText(segment.text);
          else pendingAssistant.push(segment);
        }
      }
    }

    const usage = pickUsage(record, options.extraUsageFromRecord);
    if (!usage) return;
    usageRecords += 1;

    const messageId = pickString(message, ["id"])
      || pickString(record, ["id", "uuid", "messageId", "message_id"])
      || `line-${usageRecords}`;

    // 原文分段先于「零 token 跳过」收集：Claude 的 <synthetic> 等零用量记录
    // 不产生事件，但会话详情页仍应能展开它的正文。
    if (withPrompts) {
      prompts.set(messageId, {
        userSegments: capSegments(extractSegments(lastUserBlocks)),
        assistantSegments: capSegments(pendingAssistant),
      });
      pendingAssistant = [];
      lastAssistantText = "";
    }

    // 全零记录（如 Qoder 把用量留在服务端的日志）不入库，避免污染统计。
    if (usage.totalTokens === 0) {
      skippedZeroRecords += 1;
      return;
    }

    const eventKey = `${platformId}\0${file.projectName}\0${session.sessionId}\0${messageId}`;

    eventsByKey.set(eventKey, {
      eventKey,
      sourceFile: file.storedPath || file.filePath,
      messageId,
      sessionId: session.sessionId,
      projectName: file.projectName,
      timestamp: timestamp || session.timestamp,
      model: model || session.model || "unknown",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      totalTokens: usage.totalTokens,
      platform: platformId,
    });
  }

  return {
    addLine,
    finish(): ParsedPlatformLog {
      return {
        session,
        events: Array.from(eventsByKey.values()),
        invalidLines,
        usageRecords,
        duplicateRecords: Math.max(0, usageRecords - skippedZeroRecords - eventsByKey.size),
        prompts,
      };
    },
  };
}

/** 整份解析一个文件（便利包装）。 */
export function parseClaudeJsonlFile(
  content: string,
  file: PlatformFileInfo,
  platformId: string,
  options: ClaudeJsonlParseOptions = {},
): ParsedPlatformLog {
  const parser = createClaudeJsonlParser(file, platformId, options);
  for (const line of content.split(/\r?\n/)) parser.addLine(line);
  return parser.finish();
}
