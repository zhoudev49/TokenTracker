// OpenCode（opencode.ai 的编码 agent）用量读取。
//
// 与其他平台不同，OpenCode 不写 JSONL，而是把所有会话写进一个 SQLite 库：
//   $XDG_DATA_HOME/opencode/opencode.db（默认 ~/.local/share/opencode/opencode.db）
//
// 库结构（v1.18 实测）：
//   session  — 会话聚合：directory(cwd)、model(JSON)、tokens_* 、time_created
//   message  — 每条消息一行，data 为 JSON；assistant 消息带
//              tokens: { total, input, output, reasoning, cache: { read, write } }
//
// 口径：`input` **不含**缓存读（实测 total = input + output + reasoning
// + cache.read + cache.write）。本工具的四项口径是「纯输入 / 输出 / 缓存读 / 缓存写」，
// 因此把 reasoning 并入 output —— 推理 token 本身就是输出 token 的一种。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  encodeProjectName,
  normalizeTimestamp,
  toTokenCount,
  type ParsedPlatformLog,
  type PlatformFileInfo,
} from "./platform-adapter";
import { all, closeDatabase, databaseFileSignature, openReadonly, tableExists } from "./sqlite-util";
import type { SessionSummary, UsageEvent } from "./types";

const PLATFORM_ID = "opencode";

/** 默认数据库路径（尊重 XDG_DATA_HOME）。 */
export function defaultOpenCodeDatabasePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

export const OPENCODE_DATABASE_PATH: string = process.env.TOKEN_TRACKER_OPENCODE_DB
  ? path.resolve(process.env.TOKEN_TRACKER_OPENCODE_DB)
  : defaultOpenCodeDatabasePath();

interface MessageRow {
  messageId: string;
  sessionId: string;
  directory: string | null;
  data: string;
}

interface SessionRow {
  sessionId: string;
  directory: string;
  model: string | null;
  timeCreated: number | null;
}

/** 解析 session.model 里形如 {"id":"glm-4.6","providerID":"..."} 的模型信息。 */
function readModelName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const id = record.id ?? record.modelID ?? record.modelId;
      return typeof id === "string" && id.trim() ? id : null;
    }
  } catch {
    // 不是 JSON 就当纯模型名处理
  }
  return raw.trim() || null;
}

interface OpenCodeTokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

function readTokens(data: Record<string, unknown>): OpenCodeTokens | null {
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const source = tokens as Record<string, unknown>;
  const cache = source.cache && typeof source.cache === "object" ? (source.cache as Record<string, unknown>) : {};
  return {
    input: toTokenCount(source.input),
    output: toTokenCount(source.output),
    reasoning: toTokenCount(source.reasoning),
    cacheRead: toTokenCount(cache.read),
    cacheWrite: toTokenCount(cache.write),
  };
}

/** 读取整个 OpenCode 库，返回所有会话的用量事件（数据库被当作「一个源文件」整份重建）。 */
export async function readOpenCodeDatabase(databasePath: string): Promise<ParsedPlatformLog> {
  const database = await openReadonly(databasePath);
  try {
    if (!(await tableExists(database, "session")) || !(await tableExists(database, "message"))) {
      return { session: emptySession(), events: [], invalidLines: 0, usageRecords: 0, duplicateRecords: 0 };
    }

    const sessions = await all<SessionRow>(database, `
      SELECT id AS sessionId, directory, model, time_created AS timeCreated FROM session
    `);
    const messages = await all<MessageRow>(database, `
      SELECT m.id AS messageId, m.session_id AS sessionId, s.directory AS directory, m.data AS data
      FROM message m
      LEFT JOIN session s ON s.id = m.session_id
    `);

    const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
    const events: UsageEvent[] = [];
    let invalidLines = 0;
    let usageRecords = 0;
    let skippedZeroRecords = 0;

    for (const row of messages) {
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.data);
        if (!parsed || typeof parsed !== "object") {
          invalidLines += 1;
          continue;
        }
        data = parsed as Record<string, unknown>;
      } catch {
        invalidLines += 1;
        continue;
      }

      const tokens = readTokens(data);
      if (!tokens) continue;
      usageRecords += 1;

      // 四项相加 = 总量；reasoning 归入 output。
      const inputTokens = tokens.input;
      const outputTokens = tokens.output + tokens.reasoning;
      const cacheReadTokens = tokens.cacheRead;
      const cacheCreationTokens = tokens.cacheWrite;
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
      if (totalTokens === 0) {
        skippedZeroRecords += 1;
        continue;
      }

      const session = sessionById.get(row.sessionId);
      const projectName = encodeProjectName(session ? session.directory : row.directory);
      const time = data.time && typeof data.time === "object" ? (data.time as Record<string, unknown>) : {};
      const model = typeof data.modelID === "string" && data.modelID.trim()
        ? data.modelID
        : readModelName(session ? session.model : null);

      events.push({
        eventKey: `${PLATFORM_ID}\0${projectName}\0${row.sessionId}\0${row.messageId}`,
        sourceFile: path.basename(databasePath),
        messageId: row.messageId,
        sessionId: row.sessionId,
        projectName,
        timestamp: normalizeTimestamp(time.completed ?? time.created ?? (session ? session.timeCreated : null)),
        model: model || "unknown",
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
        platform: PLATFORM_ID,
      });
    }

    return {
      session: emptySession(),
      events,
      invalidLines,
      usageRecords,
      duplicateRecords: Math.max(0, usageRecords - skippedZeroRecords - events.length),
    };
  } finally {
    await closeDatabase(database);
  }
}

function emptySession(): SessionSummary {
  // 库里没有单一「当前会话」概念：会话元信息由每条事件自身携带。
  return { sessionId: "", projectName: "", timestamp: null, model: null };
}

/** 「编码项目名 -> 真实目录」映射，用于前端展示可读路径。 */
export async function loadOpenCodeProjectRealPaths(databasePath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!fs.existsSync(databasePath)) return map;
  const database = await openReadonly(databasePath);
  try {
    const rows = await all<{ directory: string }>(
      database,
      "SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != ''",
    );
    for (const row of rows) map.set(encodeProjectName(row.directory), row.directory);
  } catch {
    // 库结构不符时返回空映射，前端回退到字符串解码
  } finally {
    await closeDatabase(database);
  }
  return map;
}

/** 把数据库文件包装成「一个源文件」，复用 server 的文件级同步状态机。 */
export function openCodeFileInfo(databasePath: string, projectName = "opencode"): PlatformFileInfo | null {
  const signature = databaseFileSignature(databasePath);
  if (!signature) return null;
  return {
    filePath: databasePath,
    storedPath: path.basename(databasePath),
    projectName,
    sessionId: projectName,
    modifiedTimeMs: signature.modifiedTimeMs,
    fileSize: signature.fileSize,
  };
}
