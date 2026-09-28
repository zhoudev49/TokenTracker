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

/**
 * 把某个字段转成计数，非可用值返回 null。
 *
 * 不能只看 `Number.isFinite(Number(value))`：`Number("")`、`Number("  ")`、`Number(false)`、
 * `Number([])` 全都等于 0 且是有限数，于是 `input_tokens: ""` 会被当成「确实是 0」，
 * 别名里真正有值的 `prompt_tokens: 500` 就永远轮不到，整桶变 0。
 * 因此只接受「数字」或「非空且能解析成数字的字符串」。
 */
function toUsableCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
  }
  // 布尔、数组、对象一律视为无效：它们不是 token 计数的合法表示。
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): { value: number; found: boolean } {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const count = toUsableCount(value);
    // 该键存在但值不可用（空串 / "n/a" / false / {}）：继续找下一个别名，
    // 而不是认定「找到了 0」并把整桶清零。
    if (count === null) continue;
    return { value: count, found: true };
  }
  return { value: 0, found: false };
}

/**
 * 与 pickNumber 同源，但**保留原始数值不做截断**。
 * 用于「输入是否含缓存」这类需要做等值判断的场合：上游发浮点数时
 * （如 1000.6 / 500.6 / 1501.2），先截断再比较会得到 1000 + 500 !== 1501 而误判，
 * 于是缓存被重复叠加到已含缓存的输入上（总量翻倍，且四项相加仍等于总量，不变量抓不到）。
 */
function pickRawNumber(source: Record<string, unknown>, keys: string[]): { value: number; found: boolean } {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    // 与 toUsableCount 同样只接受数字或非空数字字符串，但**保留小数**不截断。
    let count: number;
    if (typeof value === "number") count = value;
    else if (typeof value === "string" && value.trim()) count = Number(value.trim());
    else continue;
    if (!Number.isFinite(count)) continue;
    return { value: count, found: true };
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
  // 判定必须用未截断的原始值：浮点数会被逐项 Math.trunc，等值判断随之失效。
  const rawTotal = pickRawNumber(source, ["total_tokens", "totalTokens"]);
  const rawInputValue = pickRawNumber(source, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const rawOutputValue = pickRawNumber(source, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  // 容忍浮点求和误差（1e-6 相对量级）而不放过大偏差
  const inputIncludesCache = rawTotal.found
    && rawTotal.value > 0
    && Math.abs(rawTotal.value - (rawInputValue.value + rawOutputValue.value)) < 1e-6 * Math.max(1, Math.abs(rawTotal.value));

  // 缓存总量不应超过已含缓存的输入本身：两个缓存字段若来自会话级累计（上游已知的写法），
  // 相减会凭空造出 token。此时退回不含缓存的口径，宁可少扣也不要多算。
  const cacheTotal = cacheRead.value + cacheCreation.value;
  const effectiveIncludesCache = inputIncludesCache && cacheTotal <= rawInput.value;
  const inputTokens = effectiveIncludesCache
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
  // 取所有条目里的最大值：该字段是数组，前面可能存在 cached_tokens=0 的占位条目，
  // 见到第一个就返回会把后面真正有值的条目丢掉。
  let best = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const cached = pickNumber(item as Record<string, unknown>, ["cached_tokens", "cachedTokens"]);
    if (cached.found && cached.value > best) best = cached.value;
  }
  return best;
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

  // 候选列表存在的意义就是「不同平台把用量放在不同位置」，因此不能见到第一个
  // 能解析出对象就收手：某个平台新加的、只有 total_tokens 的 message.usage 占位
  // 会把后面 providerData.rawUsage 里真正完整的用量挡掉（该记录直接从统计中消失）。
  // 记下第一个非空结果作为兜底，优先返回真正带 token 的那个。
  let fallback: NormalizedUsage | null = null;
  for (const candidate of candidates) {
    const normalized = readUsageSnapshot(candidate);
    if (!normalized) continue;
    if (!fallback) fallback = normalized;
    if (normalized.totalTokens === 0) continue;

    // total_tokens 缺失时缓存读可能只藏在 *_details 里，这里补一次。
    if (normalized.cacheReadTokens === 0) {
      const detailCacheRead = readCacheReadFromDetails(asRecord(candidate));
      if (detailCacheRead > 0) {
        const raw = asRecord(candidate);
        // 键表必须与 readUsageSnapshot 完全一致：此前这里少了 promptTokens / completionTokens，
        // 于是同一份对象在 camelCase 拼写下这里读不到值、判定失效，缓存被重复计入。
        const rawInput = raw ? pickRawNumber(raw, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]).value : 0;
        const output = raw ? pickRawNumber(raw, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]).value : 0;
        const reportedTotal = raw ? pickRawNumber(raw, ["total_tokens", "totalTokens"]).value : 0;
        // 同样是未截断的原始值比较（浮点上游会因逐项取整而误判）。
        const includesCache = reportedTotal > 0
          && Math.abs(reportedTotal - (rawInput + output)) < 1e-6 * Math.max(1, Math.abs(reportedTotal));
        // details 里的 cached_tokens 是 input 的**子集**：只有当 input 本身不含它时才需要相加。
        // 无法证明口径时（没有 total_tokens），按 OpenAI Responses 的语义默认它是子集，直接扣减，
        // 否则会把同一批 token 同时记进 input 和 cacheRead。
        const shouldSubtract = includesCache || (reportedTotal === 0 && detailCacheRead <= rawInput);
        const inputTokens = shouldSubtract
          ? Math.max(0, (includesCache ? rawInput : normalized.inputTokens) - detailCacheRead)
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
  return fallback;
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
  // 绝对行号：从文件开头累计，与是否带 usage 无关。
  // 兜底 messageId 必须用它而不是 usageRecords —— usageRecords 是「本实例内第几条用量」，
  // 增量同步每次新建解析器都从 1 重来，会导致不同批次的第 1 条算出同一个 event_key，
  // 后一次同步把前一次的行覆盖掉（静默丢 token）。
  let linesSeen = 0;
  let lastUserBlocks: unknown = null;
  let pendingAssistant: Segment[] = [];
  let lastAssistantText = "";

  function pushAssistantText(text: string): void {
    if (!text || !text.trim()) return;
    if (text === lastAssistantText) return; // 同一段正文在快照更新里会重复出现
    lastAssistantText = text;
    pendingAssistant.push({ kind: "text", text });
  }

  function addLine(line: string, lineOffset?: number): void {
    linesSeen += 1;
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

    // 兜底 id：优先用记录自带的各种 id；都没有时退化为「该行在文件中的起始字节偏移」。
    // 不能用数组下标/计数：增量同步每次都新建解析器，计数会从头重来，
    // 导致不同批次的记录算出同一个 event_key 而互相覆盖（静默丢 token）。
    // 字节偏移在多次同步之间稳定、且同一行重读时幂等，正好满足 upsert 语义。
    const fallbackId = lineOffset === null || lineOffset === undefined
      ? `line-${linesSeen}`
      : `offset-${lineOffset}`;
    const messageId = pickString(message, ["id"])
      || pickString(record, ["id", "uuid", "messageId", "message_id"])
      || fallbackId;

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
  // 整份解析也要给出每行的字节偏移，才能与增量解析算出同一套兜底 id ——
  // 否则同一个文件在「整份重建」与「增量续读」两条路径下会得到不同的 event_key，
  // 同一行被存成两行（重复计数）。这里的偏移按 UTF-8 字节计，与增量侧一致。
  let offset = 0;
  for (const line of content.split(/\r?\n/)) {
    parser.addLine(line, offset);
    offset += Buffer.byteLength(line, "utf8") + 1; // +1 为被 split 掉的 '\n'
  }
  return parser.finish();
}
