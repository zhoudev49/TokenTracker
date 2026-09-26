// ZCode（GLM 生态的编码 CLI）用量读取。
//
// ZCode 把每次模型调用写进自己库里的 `model_usage` 表：
//   ~/.zcode/cli/db/db.sqlite
//
// 相关列（v0.16 实测）：
//   session_id / model_id / provider_id / query_source（main_turn / session_title / …）
//   started_at、input_tokens、output_tokens、reasoning_tokens、
//   cache_creation_input_tokens、cache_read_input_tokens、
//   provider_total_tokens、computed_total_tokens
//   会话的 cwd 在 `session.directory`。
//
// 口径：`input_tokens` **已包含**缓存读/写（实测 computed_total_tokens == input_tokens
// + output_tokens，且 (input - cache_read - cache_creation) + output + cache_read
// + cache_creation == computed_total_tokens），因此复用统一的 usage 归一函数把缓存剥离出来。
// 另外 reasoning_tokens 是 output_tokens 的子集，不再重复累加。

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { readUsageSnapshot } from "./claude-jsonl-parser";
import { encodeProjectName, normalizeTimestamp, type ParsedPlatformLog, type PlatformFileInfo } from "./platform-adapter";
import { all, closeDatabase, databaseFileSignature, openReadonly, tableExists } from "./sqlite-util";
import type { SessionSummary, UsageEvent } from "./types";

const PLATFORM_ID = "zcode";

export const ZCODE_DATABASE_PATH: string = process.env.TOKEN_TRACKER_ZCODE_DB
  ? path.resolve(process.env.TOKEN_TRACKER_ZCODE_DB)
  : path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

interface ModelUsageRow {
  usageId: string;
  sessionId: string;
  modelId: string;
  directory: string | null;
  startedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  computedTotalTokens: number | null;
  providerTotalTokens: number | null;
}

export async function readZCodeDatabase(databasePath: string): Promise<ParsedPlatformLog> {
  const database = await openReadonly(databasePath);
  try {
    if (!(await tableExists(database, "model_usage"))) {
      return { session: emptySession(), events: [], invalidLines: 0, usageRecords: 0, duplicateRecords: 0 };
    }
    const hasSessionTable = await tableExists(database, "session");

    const rows = await all<ModelUsageRow>(database, `
      SELECT
        u.id AS usageId,
        u.session_id AS sessionId,
        u.model_id AS modelId,
        ${hasSessionTable ? "s.directory" : "NULL"} AS directory,
        u.started_at AS startedAt,
        u.input_tokens AS inputTokens,
        u.output_tokens AS outputTokens,
        u.cache_creation_input_tokens AS cacheCreationInputTokens,
        u.cache_read_input_tokens AS cacheReadInputTokens,
        u.computed_total_tokens AS computedTotalTokens,
        u.provider_total_tokens AS providerTotalTokens
      FROM model_usage u
      ${hasSessionTable ? "LEFT JOIN session s ON s.id = u.session_id" : ""}
    `);

    const events: UsageEvent[] = [];
    let usageRecords = 0;
    let skippedZeroRecords = 0;

    for (const row of rows) {
      usageRecords += 1;
      const normalized = readUsageSnapshot({
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cache_read_input_tokens: row.cacheReadInputTokens,
        cache_creation_input_tokens: row.cacheCreationInputTokens,
        total_tokens: row.computedTotalTokens ?? row.providerTotalTokens ?? 0,
      });
      if (!normalized || normalized.totalTokens === 0) {
        skippedZeroRecords += 1;
        continue;
      }

      const projectName = encodeProjectName(row.directory);
      events.push({
        eventKey: `${PLATFORM_ID}\0${projectName}\0${row.sessionId}\0${row.usageId}`,
        sourceFile: path.basename(databasePath),
        messageId: row.usageId,
        sessionId: row.sessionId,
        projectName,
        timestamp: normalizeTimestamp(row.startedAt),
        model: row.modelId || "unknown",
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cacheReadTokens: normalized.cacheReadTokens,
        cacheCreationTokens: normalized.cacheCreationTokens,
        totalTokens: normalized.totalTokens,
        platform: PLATFORM_ID,
      });
    }

    return {
      session: emptySession(),
      events,
      invalidLines: 0,
      usageRecords,
      duplicateRecords: Math.max(0, usageRecords - skippedZeroRecords - events.length),
    };
  } finally {
    await closeDatabase(database);
  }
}

function emptySession(): SessionSummary {
  return { sessionId: "", projectName: "", timestamp: null, model: null };
}

export async function loadZCodeProjectRealPaths(databasePath: string): Promise<Map<string, string>> {
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
    // 库结构不符时返回空映射
  } finally {
    await closeDatabase(database);
  }
  return map;
}

export function zcodeFileInfo(databasePath: string, projectName = "zcode"): PlatformFileInfo | null {
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
