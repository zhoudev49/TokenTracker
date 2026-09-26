import test from "node:test";
import assert from "node:assert/strict";
import { parseUsageRecords } from "../src/log-parser";
import type { LogFileInfo } from "../src/types";

const logFile: LogFileInfo = {
  filePath: "C:/logs/session.jsonl",
  projectName: "demo-project",
  sessionId: "session-1",
};

test("deduplicates repeated message snapshots and keeps the latest usage", () => {
  const records = [
    {
      sessionId: "session-1",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: {
        id: "message-1",
        model: "model-a",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
      },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-08-01T10:00:01.000Z",
      message: {
        id: "message-1",
        model: "model-a",
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 6 },
      },
    },
  ];
  const parsed = parseUsageRecords(records.map((record) => JSON.stringify(record)).join("\n") + "\n", logFile);

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.duplicateRecords, 1);
  assert.equal(parsed.events[0].totalTokens, 21);
  assert.equal(parsed.events[0].timestamp, "2026-08-01T10:00:01.000Z");
});

test("counts invalid JSON without dropping valid records", () => {
  const content = [
    "not-json",
    JSON.stringify({
      session_id: "session-2",
      timestamp: "2026-08-02T10:00:00Z",
      message: {
        id: "message-2",
        model: "model-b",
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 },
      },
    }),
    "",
  ].join("\n");
  const parsed = parseUsageRecords(content, logFile);

  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].sessionId, "session-2");
  assert.equal(parsed.events[0].cacheCreationTokens, 3);
});
