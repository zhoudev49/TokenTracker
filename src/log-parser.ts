// Claude Code .jsonl 日志解析：token 抽取、原文分段（text/thinking/tool_use/tool_result）。
import type { LogFileInfo, ParsedLog, Segment, SessionSummary, UsageEvent } from "./types";

function toTokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function normalizeTimestamp(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(String(value));
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

// 把 Claude Code 消息的 content（string | 块数组）抽成可读文本。
// 完整保留：text 原文、thinking、tool_use 的 名称+输入参数(JSON)、tool_result 的实际内容。
function formatToolUse(block: ContentBlock): string {
  const name = block.name || "tool";
  const input = block.input;
  let detail = "";
  if (input && typeof input === "object") {
    try {
      detail = JSON.stringify(input, null, 2);
    } catch {
      detail = String(input);
    }
  } else if (input != null) {
    detail = String(input);
  }
  return `[工具调用: ${name}]\n${detail}`;
}

function formatToolResult(block: ContentBlock): string {
  const tag = block.is_error ? "工具返回(错误)" : "工具返回";
  return `[${tag}]\n${extractToolResultText(block)}`;
}

function extractToolResultText(block: ContentBlock): string {
  const content = block.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return item == null ? "" : String(item);
        const c = item as ContentBlock;
        if (c.type === "text") return c.text || "";
        if (c.type === "image") return "[图片]";
        if (c.type === "tool_use") return formatToolUse(c);
        return JSON.stringify(c, null, 2);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content, null, 2);
  }
  return "";
}

// 单段文本上限，防止超大工具返回（如整文件 dump）把前端/响应撑爆。
const MAX_SEGMENT_CHARS = 20000;
function capText(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "\n\n…（内容过长已截断，完整内容见原始日志）";
}

// 把 content 拆成结构化分段，供前端按类型渲染成独立标签块。
// 段类型：text / thinking / tool_use / tool_result。
function extractSegments(content: unknown): Segment[] {
  if (!content) return [];
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ kind: "text", text: String(content) }];
  }
  const segs: Segment[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      if (item != null) segs.push({ kind: "text", text: String(item) });
      continue;
    }
    const block = item as ContentBlock;
    switch (block.type) {
      case "text":
        if (block.text) segs.push({ kind: "text", text: block.text });
        break;
      case "thinking":
        if (block.thinking) segs.push({ kind: "thinking", text: block.thinking });
        break;
      case "tool_use": {
        const name = block.name || "tool";
        let detail = "";
        if (block.input && typeof block.input === "object") {
          try {
            detail = JSON.stringify(block.input, null, 2);
          } catch {
            detail = String(block.input);
          }
        } else if (block.input != null) {
          detail = String(block.input);
        }
        segs.push({ kind: "tool_use", name, text: detail });
        break;
      }
      case "tool_result":
        segs.push({ kind: "tool_result", text: extractToolResultText(block), isError: !!block.is_error });
        break;
      default:
        if (block.text) segs.push({ kind: "text", text: block.text });
        else if (typeof block.content === "string") segs.push({ kind: "text", text: block.content });
        break;
    }
  }
  const merged: Segment[] = [];
  for (const seg of segs) {
    if (seg.kind === "text" && merged.length && merged[merged.length - 1].kind === "text") {
      merged[merged.length - 1].text += "\n\n" + seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged
    .filter((seg) => seg.text && seg.text.trim())
    .map((seg) => ({ ...seg, text: capText(seg.text, MAX_SEGMENT_CHARS) }));
}

function extractText(content: unknown): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      if (item != null) parts.push(String(item));
      continue;
    }
    const block = item as ContentBlock;
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "thinking":
        if (block.thinking) parts.push(`[思考]\n${block.thinking}`);
        break;
      case "tool_use":
        parts.push(formatToolUse(block));
        break;
      case "tool_result":
        parts.push(formatToolResult(block));
        break;
      default:
        if (block.text) parts.push(block.text);
        else if (typeof block.content === "string") parts.push(block.content);
        break;
    }
  }
  return parts.join("\n\n").trim();
}

function createUsageRecordParser(logFile: LogFileInfo): {
  addLine(line: string): void;
  finish(): ParsedLog;
} {
  const eventsByKey = new Map<string, UsageEvent>();
  const session: SessionSummary = {
    sessionId: logFile.sessionId,
    projectName: logFile.projectName,
    timestamp: null,
    model: null,
  };
  let invalidLines = 0;
  let usageRecords = 0;

  function addLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLines += 1;
      return;
    }

    const recordSessionId = record.sessionId || record.session_id;
    if (recordSessionId) {
      session.sessionId = String(recordSessionId);
    }

    const timestamp = normalizeTimestamp(record.timestamp);
    if (timestamp && (!session.timestamp || timestamp < session.timestamp)) {
      session.timestamp = timestamp;
    }

    const message = record.message;
    const usage = message && message.usage;
    if (!usage || !message.id || !session.sessionId) {
      return;
    }

    usageRecords += 1;
    const inputTokens = toTokenCount(usage.input_tokens);
    const outputTokens = toTokenCount(usage.output_tokens);
    const cacheReadTokens = toTokenCount(
      usage.cache_read_tokens ?? usage.cache_read_input_tokens,
    );
    const cacheCreationTokens = toTokenCount(
      usage.cache_creation_tokens ?? usage.cache_creation_input_tokens,
    );
    const model: string | null = message.model || null;
    const eventKey = `${logFile.projectName}\0${session.sessionId}\0${message.id}`;

    if (!session.model && model) {
      session.model = model;
    }

    eventsByKey.set(eventKey, {
      eventKey,
      sourceFile: logFile.filePath,
      messageId: String(message.id),
      sessionId: session.sessionId,
      projectName: logFile.projectName,
      timestamp,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens:
        inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    });
  }

  return {
    addLine,
    finish(): ParsedLog {
      return {
        session,
        events: Array.from(eventsByKey.values()),
        invalidLines,
        usageRecords,
        duplicateRecords: usageRecords - eventsByKey.size,
      };
    },
  };
}

function parseUsageRecords(content: string, logFile: LogFileInfo): ParsedLog {
  const parser = createUsageRecordParser(logFile);
  for (const line of content.split(/\r?\n/)) {
    parser.addLine(line);
  }
  return parser.finish();
}

export = {
  createUsageRecordParser,
  parseUsageRecords,
  toTokenCount,
  extractText,
  extractSegments,
};
