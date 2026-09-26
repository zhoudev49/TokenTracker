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
  assert.deepEqual(importedLogs.get(relativePath), {
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
