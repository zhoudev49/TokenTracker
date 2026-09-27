import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-db-"));
process.env.TOKEN_TRACKER_DATA_DIR = dataDirectory;

// 注意：必须用 require（而非 import）加载被测模块——TS 的 import 会提升到文件顶部，
// 导致上方 TOKEN_TRACKER_DATA_DIR 赋值失效（database.ts 在模块加载时读取 env）。
const {
  closeDatabase,
  getImportedLogFiles,
  getSessionModelBreakdown,
  getSessionSourceFiles,
  importedLogKey,
  markLogFileImported,
  migrateSourcePathsToRelative,
  processImportedChunk,
  querySessions,
  queryUsageEvents,
  queryUsageEventsForSessions,
} = require("../src/database") as typeof import("../src/database");
import type { UsageEvent } from "../src/types";

test.after(async () => {
  await closeDatabase();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    eventKey: "event-default",
    sourceFile: "project-a/session.jsonl",
    messageId: "message-default",
    sessionId: "session-default",
    projectName: "project-a",
    timestamp: "2026-08-06T00:00:00.000Z",
    model: "model-a",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 2,
    ...overrides,
  };
}

test("migrates duplicate absolute and relative log paths without violating the primary key", async () => {
  const baseDirectory = path.join(dataDirectory, "projects");
  const absolutePath = path.join(baseDirectory, "project-a", "session.jsonl");
  const relativePath = "project-a/session.jsonl";

  await markLogFileImported(absolutePath, {
    modifiedTimeMs: 100,
    fileSize: 100,
    byteOffset: 50,
    lastSyncAt: "2026-08-06T00:00:01.000Z",
    status: "error",
    error: "temporary failure",
  });
  await markLogFileImported(relativePath, {
    modifiedTimeMs: 200,
    fileSize: 200,
    byteOffset: 200,
    lastSyncAt: "2026-08-06T00:00:02.000Z",
    status: "ready",
  });

  await processImportedChunk(null, [
    makeEvent({
      eventKey: "event-absolute",
      sourceFile: absolutePath,
      messageId: "message-absolute",
      sessionId: "session-1",
      timestamp: "2026-08-06T00:00:00.000Z",
      totalTokens: 3,
    }),
    makeEvent({
      eventKey: "event-relative",
      sourceFile: relativePath,
      messageId: "message-relative",
      sessionId: "session-1",
      timestamp: "2026-08-06T00:00:01.000Z",
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    }),
  ]);

  await migrateSourcePathsToRelative(baseDirectory);

  const importedLogs = await getImportedLogFiles();
  assert.equal(importedLogs.size, 1);
  // 键为 `platform\0file_path`：不同平台的相对路径会完全相同，必须带平台前缀区分
  assert.deepEqual(importedLogs.get(importedLogKey("claude", relativePath)), {
    modifiedTimeMs: 200,
    fileSize: 200,
    byteOffset: 200,
    lastSyncAt: "2026-08-06T00:00:02.000Z",
    status: "ready",
    error: null,
    platform: "claude",
  });

  assert.deepEqual(await getSessionSourceFiles("session-1", "project-a"), [relativePath]);

  await migrateSourcePathsToRelative(baseDirectory);
  assert.equal((await getImportedLogFiles()).size, 1);
});

test("queries events only for the requested session page", async () => {
  await processImportedChunk(null, [makeEvent({
    eventKey: "event-other-session",
    sourceFile: "project-a/other.jsonl",
    messageId: "message-other",
    sessionId: "session-2",
    timestamp: "2026-08-06T00:00:02.000Z",
  })]);

  const events = await queryUsageEventsForSessions({}, [{
    sessionId: "session-1",
    projectName: "project-a",
  }]);
  assert.deepEqual(events.map((event) => event.sessionId), ["session-1", "session-1"]);
});

test("keeps model breakdowns isolated by project", async () => {
  await processImportedChunk(null, [makeEvent({
    eventKey: "event-same-session-other-project",
    sourceFile: "project-b/session.jsonl",
    messageId: "message-project-b",
    sessionId: "session-1",
    projectName: "project-b",
    timestamp: "2026-08-06T00:00:03.000Z",
    model: "model-b",
  })]);

  const breakdown = await getSessionModelBreakdown([
    { sessionId: "session-1", projectName: "project-a" },
    { sessionId: "session-1", projectName: "project-b" },
  ]);
  assert.deepEqual(breakdown["project-a\0session-1"].map((item) => item.model), ["model-a"]);
  assert.deepEqual(breakdown["project-b\0session-1"].map((item) => item.model), ["model-b"]);
});

test("filters timestamps by local-day ranges", async () => {
  const value = new Date("2026-08-06T00:00:00.000Z");
  const localDate = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");

  const events = await queryUsageEvents({ date: localDate });
  assert.ok(events.some((event) => event.sessionId === "session-1"));
  assert.deepEqual(await queryUsageEvents({ date: "not-a-date" }), []);
});

test("sorts sessions by their latest activity while preserving the start time", async () => {
  await processImportedChunk(null, [makeEvent({
    eventKey: "event-session-1-latest",
    messageId: "message-session-1-latest",
    sessionId: "session-1",
    timestamp: "2026-08-06T00:00:04.000Z",
  })]);

  const sessions = await querySessions({}, { orderBy: "timestamp DESC" });
  const session = sessions.find((item) =>
    item.sessionId === "session-1" && item.projectName === "project-a");

  assert.equal(sessions[0].sessionId, "session-1");
  assert.equal(session!.firstTimestamp, "2026-08-06T00:00:00.000Z");
  assert.equal(session!.timestamp, "2026-08-06T00:00:04.000Z");
  assert.equal(session!.lastTimestamp, "2026-08-06T00:00:04.000Z");
});

test("serializes concurrent writes instead of nesting transactions", async () => {
  // Claude 与 Codex 的同步是并发的，且共用一条 sqlite 连接。若事务不排队，
  // 第二个 BEGIN 会报 "cannot start a transaction within a transaction"。
  const makeEvents = (platform: string): UsageEvent[] => Array.from({ length: 5 }, (unused, index) => makeEvent({
    eventKey: `concurrent-${platform}-${index}`,
    sourceFile: `project-concurrent/${platform}.jsonl`,
    messageId: `message-${platform}-${index}`,
    sessionId: `session-concurrent-${platform}`,
    projectName: "project-concurrent",
    timestamp: `2026-08-06T01:00:0${index}.000Z`,
    model: platform === "codex" ? "gpt-5.5" : "model-a",
    platform,
  }));

  await Promise.all([
    processImportedChunk(null, makeEvents("claude")),
    processImportedChunk(null, makeEvents("codex")),
  ]);

  const claudeEvents = await queryUsageEvents({ projectName: "project-concurrent", platform: "claude" });
  const codexEvents = await queryUsageEvents({ projectName: "project-concurrent", platform: "codex" });
  assert.equal(claudeEvents.length, 5);
  assert.equal(codexEvents.length, 5);
  assert.ok(codexEvents.every((event) => event.platform === "codex"));
});

// ---------------------------------------------------------------------------
// 回归测试：跨平台隔离、导出规模、事务重入
// ---------------------------------------------------------------------------

test("删除某个平台的源文件不会连带删除其他平台的用量", async () => {
  // 回归：file_path 存的是相对各平台根目录的路径，
  // 而 Claude 与 WorkBuddy 的目录结构同为 projects/<编码目录>/<会话>.jsonl，
  // 因此两个平台会产生完全相同的字符串。曾经 deleteUsageEventsForFile 只按
  // source_file 删除，导致同步 claude 时把 workbuddy 的用量一起删掉。
  const sharedPath = "projects/-Users-dev-proj/shared.jsonl";
  const { deleteUsageEventsForFile } = require("../src/database") as typeof import("../src/database");

  await processImportedChunk(null, [
    makeEvent({
      eventKey: "isolation-claude",
      sourceFile: sharedPath,
      messageId: "isolation-claude-1",
      sessionId: "isolation-shared",
      projectName: "isolation-project",
      timestamp: "2026-08-06T02:00:00.000Z",
      inputTokens: 165, outputTokens: 0, totalTokens: 165,
      platform: "claude",
    }),
  ]);
  await processImportedChunk(null, [
    makeEvent({
      eventKey: "isolation-workbuddy",
      sourceFile: sharedPath,
      messageId: "isolation-workbuddy-1",
      sessionId: "isolation-shared",
      projectName: "isolation-project",
      timestamp: "2026-08-06T02:00:01.000Z",
      inputTokens: 1125, outputTokens: 0, totalTokens: 1125,
      platform: "workbuddy",
    }),
  ]);

  // 只统计本次测试的会话，避免受同库中其他用例的数据影响
  const countIsolation = async (platform: string) =>
    (await queryUsageEvents({ platform, sessionId: "isolation-shared" })).length;

  assert.equal(await countIsolation("workbuddy"), 1);
  assert.equal(await countIsolation("claude"), 1);

  await deleteUsageEventsForFile(sharedPath, "claude");

  assert.equal(await countIsolation("claude"), 0, "claude 的事件应被删除");
  assert.equal(await countIsolation("workbuddy"), 1, "workbuddy 的用量必须保留");
  const survived = await queryUsageEvents({ platform: "workbuddy", sessionId: "isolation-shared" });
  assert.equal(survived[0].totalTokens, 1125);
});

test("imported_logs 以 (平台, 路径) 为键，同一路径在不同平台互不覆盖", async () => {
  const { importedLogKey } = require("../src/database") as typeof import("../src/database");
  const sharedPath = "projects/-Users-dev-proj/collide.jsonl";

  await markLogFileImported(sharedPath, {
    modifiedTimeMs: 111, fileSize: 10, byteOffset: 10, status: "ready", platform: "claude",
  });
  await markLogFileImported(sharedPath, {
    modifiedTimeMs: 222, fileSize: 20, byteOffset: 20, status: "ready", platform: "workbuddy",
  });

  const logs = await getImportedLogFiles();
  const claudeState = logs.get(importedLogKey("claude", sharedPath));
  const workbuddyState = logs.get(importedLogKey("workbuddy", sharedPath));
  assert.ok(claudeState, "claude 的同步状态应独立存在");
  assert.ok(workbuddyState, "workbuddy 的同步状态应独立存在");
  assert.equal(claudeState!.modifiedTimeMs, 111);
  assert.equal(workbuddyState!.modifiedTimeMs, 222);
});

test("超过 SQLite 表达式深度上限的会话数仍能查询事件", async () => {
  // 回归：曾经用 N 个 (session_id = ? AND project_name = ?) 的 OR 串，
  // 第 998 个会话就会触发 "Expression tree is too large (maximum depth 1000)"，
  // 而导出接口按 5000 会话封顶 —— 对累积到 998 个会话的用户导出必然 500。
  const manySessions = Array.from({ length: 1500 }, (unused, index) => ({
    sessionId: `bulk-session-${index}`,
    projectName: "bulk-project",
  }));

  const events = await queryUsageEventsForSessions({}, manySessions);
  assert.ok(Array.isArray(events), "1500 个会话不应抛错");
});

test("事件按 (session_id, project_name) 批量查询时结果与逐个查询一致", async () => {
  await processImportedChunk(null, [
    makeEvent({
      eventKey: "batch-a", sourceFile: "batch/a.jsonl", messageId: "batch-a",
      sessionId: "batch-session-a", projectName: "batch-project",
      timestamp: "2026-08-06T03:00:00.000Z", inputTokens: 3, outputTokens: 0, totalTokens: 3,
      platform: "claude",
    }),
    makeEvent({
      eventKey: "batch-b", sourceFile: "batch/b.jsonl", messageId: "batch-b",
      sessionId: "batch-session-b", projectName: "batch-project",
      timestamp: "2026-08-06T03:00:01.000Z", inputTokens: 5, outputTokens: 0, totalTokens: 5,
      platform: "claude",
    }),
  ]);

  const events = await queryUsageEventsForSessions({}, [
    { sessionId: "batch-session-a", projectName: "batch-project" },
    { sessionId: "batch-session-b", projectName: "batch-project" },
    { sessionId: "batch-session-missing", projectName: "batch-project" },
  ]);
  assert.deepEqual(events.map((event) => event.eventKey).sort(), ["batch-a", "batch-b"]);
  // 按时间倒序：最新的在前
  assert.equal(events[0].eventKey, "batch-b");
});

test("嵌套事务不会死锁，且失败的事务不会毒化事务队列", async () => {
  // 回归：withTransaction 只对「新事务」排队。若内层也去排队，
  // 内层等外层释放队列、外层等内层完成 —— 永久死锁。
  // 另外事务失败后队列必须仍可用（否则一次回滚会卡死后续所有写入）。
  const { withTransaction } = require("../src/database") as typeof import("../src/database");

  await withTransaction(async () => {
    // processImportedChunk 内部会再次进入 withTransaction（upsertUsageEvents）
    await processImportedChunk(null, [
      makeEvent({
        eventKey: "nested-tx", sourceFile: "nested/tx.jsonl", messageId: "nested-tx",
        sessionId: "nested-session", projectName: "nested-project",
        timestamp: "2026-08-06T04:00:00.000Z", inputTokens: 7, outputTokens: 0, totalTokens: 7,
        platform: "claude",
      }),
    ]);
  });
  assert.equal((await queryUsageEvents({ sessionId: "nested-session" })).length, 1);

  await assert.rejects(
    () => withTransaction(async () => { throw new Error("intentional failure"); }),
    /intentional failure/,
  );

  await processImportedChunk(null, [
    makeEvent({
      eventKey: "after-failure", sourceFile: "nested/after.jsonl", messageId: "after-failure",
      sessionId: "nested-session-2", projectName: "nested-project-2",
      timestamp: "2026-08-06T04:00:01.000Z", inputTokens: 9, outputTokens: 0, totalTokens: 9,
      platform: "claude",
    }),
  ]);
  assert.equal((await queryUsageEvents({ sessionId: "nested-session-2" })).length, 1);
});
