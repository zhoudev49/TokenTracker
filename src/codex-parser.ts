// 解析 Codex CLI 的会话日志（rollout 文件），提取 token 用量。
// 数据来源：~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<时间>-<session_id>.jsonl
//
// 文件为 JSONL，每行一条带 type 的记录，与用量相关的有三类：
//   session_meta  — 会话元信息（session_id、cwd、起始时间）
//   turn_context  — 每轮上下文，其中 payload.model 是当前模型名
//   event_msg / payload.type === "token_count" — 用量快照
//
// 关键：token_count 的 info.total_token_usage 是「会话累计值」，
// info.last_token_usage 是「上一轮增量」。不能直接累加 last_token_usage：
// Codex 会在同一轮重复发送 token_count（累计值不变、last 值重复），
// 直接累加 last 会重复计数（实测 11 个会话中有 4 个因此对不上账）。
// 因此这里改用「累计值差分」还原每轮增量，与文件末尾的累计值可精确对账。
//
// 另一个关键点：input_tokens 已经包含 cached_input_tokens 与
// cache_write_input_tokens。为与 Claude 的四分类口径一致（四项相加 = 总量），
// 入库前先减掉这两项，得到「纯新增输入」。

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { encodeProjectName, normalizeTimestamp, toTokenCount } from "./platform-adapter";
import type { CodexLogFileInfo, CodexParsedLog, CodexSessionFileInfo, Segment, SessionSummary, UsageEvent } from "./types";

const CODEX_SESSIONS_DIR: string = process.env.TOKEN_TRACKER_CODEX_SESSIONS_DIR
  ? path.resolve(process.env.TOKEN_TRACKER_CODEX_SESSIONS_DIR)
  : path.join(os.homedir(), ".codex", "sessions");

interface TokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

function readUsage(snapshot: unknown): TokenSnapshot | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  return {
    inputTokens: toTokenCount(s.input_tokens),
    outputTokens: toTokenCount(s.output_tokens),
    cacheReadTokens: toTokenCount(s.cached_input_tokens),
    cacheCreationTokens: toTokenCount(s.cache_write_input_tokens),
    totalTokens: toTokenCount(s.total_tokens),
  };
}

// 从 response_item 的 content 数组里取文本（Codex 用 input_text / output_text）。
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      return (block as Record<string, unknown>).text || "";
    })
    .filter(Boolean)
    .join("\n");
}

const MAX_SEGMENT_CHARS = 20000;
function capText(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max) + "\n\n…（内容过长已截断，完整内容见原始日志）";
}

interface ResponseItem {
  type?: string;
  role?: string;
  content?: unknown;
  summary?: unknown;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
}

// 把一轮内累积的 response_item 转成前端可渲染的分段，
// 段类型与 Claude 侧保持一致：text / thinking / tool_use / tool_result。
function itemsToSegments(items: ResponseItem[]): { userSegments: Segment[]; assistantSegments: Segment[] } {
  const userSegments: Segment[] = [];
  const assistantSegments: Segment[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        const text = extractContentText(item.content);
        if (!text.trim()) break;
        if (item.role === "assistant") assistantSegments.push({ kind: "text", text });
        else userSegments.push({ kind: "text", text });
        break;
      }
      case "reasoning": {
        // summary 为空时只有 encrypted_content（无法解密），跳过而不是渲染密文。
        const text = Array.isArray(item.summary)
          ? item.summary.map((s: unknown) => (typeof s === "string" ? s : s && typeof s === "object" ? (s as Record<string, unknown>).text : "") || "").filter(Boolean).join("\n")
          : "";
        if (text.trim()) assistantSegments.push({ kind: "thinking", text });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = item.name || "tool";
        const raw: unknown = item.arguments != null ? item.arguments : item.input;
        let detail = typeof raw === "string" ? raw : "";
        if (raw && typeof raw === "object") {
          try {
            detail = JSON.stringify(raw, null, 2);
          } catch {
            detail = String(raw);
          }
        }
        // function_call 的 arguments 通常是 JSON 字符串，格式化后更易读。
        if (typeof raw === "string") {
          try {
            detail = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            detail = raw;
          }
        }
        assistantSegments.push({ kind: "tool_use", name, text: detail });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const output = item.output;
        let text = typeof output === "string" ? output : "";
        if (output && typeof output === "object") {
          try {
            text = JSON.stringify(output, null, 2);
          } catch {
            text = String(output);
          }
        }
        if (text.trim()) {
          userSegments.push({ kind: "tool_result", text, isError: /^Exit code: [1-9]/.test(text) });
        }
        break;
      }
      default:
        break;
    }
  }

  const cap = (segs: Segment[]): Segment[] => segs
    .filter((seg) => seg.text && seg.text.trim())
    .map((seg) => ({ ...seg, text: capText(seg.text, MAX_SEGMENT_CHARS) }));

  return { userSegments: cap(userSegments), assistantSegments: cap(assistantSegments) };
}

// 逐行解析一个 rollout 文件。withPrompts 为 true 时额外返回每轮的对话分段
// （只在查看会话详情时才需要，日常同步不解析正文，避免无谓开销）。
function parseCodexRollout(content: string, logFile: CodexLogFileInfo, options: { withPrompts?: boolean } = {}): CodexParsedLog {
  const withPrompts = options.withPrompts === true;
  const projectName = logFile.projectName;
  const events: UsageEvent[] = [];
  const prompts = new Map<string, { userSegments: Segment[]; assistantSegments: Segment[] }>();
  const session: SessionSummary & { cwd: string | null } = {
    sessionId: logFile.sessionId,
    projectName,
    timestamp: null,
    model: null,
    cwd: null,
  };

  let invalidLines = 0;
  let duplicateRecords = 0;
  let model: string | null = null;
  let turnIndex = 0;
  let pendingItems: ResponseItem[] = [];
  // 累计值基线，用于差分还原每轮增量。
  let previous: TokenSnapshot = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }

    const payload = record.payload;

    if (record.type === "session_meta" && payload) {
      if (payload.session_id) session.sessionId = String(payload.session_id);
      if (payload.cwd) session.cwd = payload.cwd;
      const metaTime = normalizeTimestamp(payload.timestamp || record.timestamp);
      if (metaTime && (!session.timestamp || metaTime < session.timestamp)) session.timestamp = metaTime;
      continue;
    }

    if (record.type === "turn_context" && payload) {
      if (payload.model) {
        model = String(payload.model);
        if (!session.model) session.model = model;
      }
      if (payload.cwd && !session.cwd) session.cwd = payload.cwd;
      continue;
    }

    if (record.type === "response_item" && withPrompts && payload) {
      pendingItems.push(payload as ResponseItem);
      continue;
    }

    if (record.type !== "event_msg" || !payload || payload.type !== "token_count") continue;

    const info = payload.info;
    const cumulative = readUsage(info && info.total_token_usage);
    if (!cumulative) continue;

    // 会话被 /compact 或重启后累计值可能回退，此时重置基线避免出现负增量。
    if (cumulative.totalTokens < previous.totalTokens) {
      previous = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };
    }

    const rawInputDelta = cumulative.inputTokens - previous.inputTokens;
    const outputTokens = cumulative.outputTokens - previous.outputTokens;
    const cacheReadTokens = cumulative.cacheReadTokens - previous.cacheReadTokens;
    const cacheCreationTokens = cumulative.cacheCreationTokens - previous.cacheCreationTokens;

    // 累计值没变 —— 同一轮的重复上报，跳过（否则会重复计数）。
    if (rawInputDelta === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
      duplicateRecords += 1;
      continue;
    }

    previous = cumulative;

    // input_tokens 含 cached + cache_write，剥离后四项相加才等于总量。
    const inputTokens = Math.max(0, rawInputDelta - cacheReadTokens - cacheCreationTokens);
    const timestamp = normalizeTimestamp(record.timestamp) || session.timestamp;
    if (timestamp && (!session.timestamp || timestamp < session.timestamp)) session.timestamp = timestamp;

    turnIndex += 1;
    const messageId = `turn-${turnIndex}`;
    events.push({
      eventKey: `codex\0${projectName}\0${session.sessionId}\0${messageId}`,
      sourceFile: logFile.storedPath || logFile.filePath,
      messageId,
      sessionId: session.sessionId,
      projectName,
      timestamp,
      model: model || "unknown",
      inputTokens: Math.max(0, inputTokens),
      outputTokens: Math.max(0, outputTokens),
      cacheReadTokens: Math.max(0, cacheReadTokens),
      cacheCreationTokens: Math.max(0, cacheCreationTokens),
      totalTokens:
        Math.max(0, inputTokens) + Math.max(0, outputTokens) +
        Math.max(0, cacheReadTokens) + Math.max(0, cacheCreationTokens),
      platform: "codex",
    });

    if (withPrompts) {
      prompts.set(messageId, itemsToSegments(pendingItems));
      pendingItems = [];
    }
  }

  return { session, events, invalidLines, duplicateRecords, usageRecords: events.length + duplicateRecords, prompts };
}

// 递归扫描 ~/.codex/sessions 下所有 rollout 文件。
function listCodexSessionFiles(): CodexSessionFileInfo[] {
  const sessionFiles: CodexSessionFileInfo[] = [];
  const pending: string[] = [CODEX_SESSIONS_DIR];

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".jsonl") continue;

      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      sessionFiles.push({
        filePath,
        // 只存相对 ~/.codex/sessions 的路径，不把 OS 用户名写进数据库。
        storedPath: path.relative(CODEX_SESSIONS_DIR, filePath).split(path.sep).join("/"),
        modifiedTimeMs: stats.mtimeMs,
        fileSize: stats.size,
      });
    }
  }
  return sessionFiles;
}

// 读取并解析单个会话文件。projectName 与 sessionId 都来自文件内的 session_meta，
// 文件名只作为 sessionId 的兜底。
function parseCodexSessionFile(filePath: string, options: { withPrompts?: boolean; storedPath?: string } = {}): CodexParsedLog | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const fallbackSessionId = path.basename(filePath, ".jsonl").replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
  // 先取 session_meta 的 cwd 才能定项目名，故分两趟：首趟只找元信息。
  let cwd: string | null = null;
  let sessionId: string = fallbackSessionId;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session_meta" && record.payload) {
      if (record.payload.cwd) cwd = record.payload.cwd;
      if (record.payload.session_id) sessionId = String(record.payload.session_id);
      break;
    }
  }

  const logFile: CodexLogFileInfo = {
    filePath,
    storedPath: options.storedPath || path.relative(CODEX_SESSIONS_DIR, filePath).split(path.sep).join("/"),
    projectName: encodeProjectName(cwd),
    sessionId,
  };
  return parseCodexRollout(content, logFile, options);
}

function resolveCodexSourcePath(storedPath: string): string {
  return path.isAbsolute(storedPath) ? storedPath : path.join(CODEX_SESSIONS_DIR, storedPath);
}

// 建立「编码项目名 -> 真实 cwd」映射，供前端展示可读路径。
// session_meta 是每个 rollout 的第一行，只读文件头即可，不必整份解析。
function loadCodexProjectRealPaths(): Map<string, string> {
  const map = new Map<string, string>();
  for (const sessionFile of listCodexSessionFiles()) {
    let fd: number;
    try {
      fd = fs.openSync(sessionFile.filePath, "r");
    } catch {
      continue;
    }
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const match = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!match) continue;
      let cwd: string;
      try {
        cwd = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        cwd = match[1].replace(/\\\\/g, "\\");
      }
      if (cwd) map.set(encodeProjectName(cwd), cwd);
    } catch {
      // 单个文件读取失败不影响其余映射
    } finally {
      fs.closeSync(fd);
    }
  }
  return map;
}

export = {
  CODEX_SESSIONS_DIR,
  listCodexSessionFiles,
  loadCodexProjectRealPaths,
  parseCodexRollout,
  parseCodexSessionFile,
  resolveCodexSourcePath,
  encodeProjectName,
};
