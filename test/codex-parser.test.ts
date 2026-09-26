import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexRollout, encodeProjectName } from "../src/codex-parser";
import type { CodexLogFileInfo } from "../src/types";

const logFile: CodexLogFileInfo = {
  filePath: "C:/codex/sessions/rollout.jsonl",
  storedPath: "2026/08/06/rollout.jsonl",
  projectName: "D--python-code-TokenTracker",
  sessionId: "session-1",
};

// 构造一条 token_count 记录。Codex 的 total_token_usage 是会话累计值，
// 且 input_tokens 已包含 cached + cache_write。
function tokenCount(timestamp: string, cumulative: ReturnType<typeof usage>): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: cumulative,
        last_token_usage: cumulative,
        model_context_window: 121600,
      },
    },
  });
}

function usage(input: number, cached: number, cacheWrite: number, output: number): {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
} {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

test("derives per-turn usage from cumulative snapshots", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-08-06T03:40:32.888Z",
      type: "session_meta",
      payload: { session_id: "abc-123", cwd: "D:\\python_code\\TokenTracker", timestamp: "2026-08-06T03:38:45.732Z" },
    }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.6-luna" } }),
    tokenCount("2026-08-06T03:40:45.842Z", usage(1000, 0, 600, 100)),
    tokenCount("2026-08-06T03:41:47.569Z", usage(3000, 600, 900, 250)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile);

  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.session.sessionId, "abc-123");
  assert.equal(parsed.session.model, "gpt-5.6-luna");

  // 第一轮：input 1000 含 cached 0 + cacheWrite 600 -> 纯输入 400
  const [first, second] = parsed.events;
  assert.equal(first.inputTokens, 400);
  assert.equal(first.cacheReadTokens, 0);
  assert.equal(first.cacheCreationTokens, 600);
  assert.equal(first.outputTokens, 100);
  assert.equal(first.totalTokens, 1100);
  assert.equal(first.platform, "codex");
  assert.equal(first.model, "gpt-5.6-luna");

  // 第二轮为累计差分：input +2000，cached +600，cacheWrite +300 -> 纯输入 1100
  assert.equal(second.inputTokens, 1100);
  assert.equal(second.cacheReadTokens, 600);
  assert.equal(second.cacheCreationTokens, 300);
  assert.equal(second.outputTokens, 150);
  assert.equal(second.totalTokens, 2150);

  // 四项相加必须等于最终累计总量，否则成本会算错
  const sum = parsed.events.reduce((total, event) => total + event.totalTokens, 0);
  assert.equal(sum, 3250);
});

test("ignores repeated token_count snapshots that carry no new usage", () => {
  const content = [
    JSON.stringify({ timestamp: "2026-08-06T03:40:32.888Z", type: "session_meta", payload: { session_id: "dup-1", cwd: "D:\\demo" } }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    tokenCount("2026-08-06T03:40:45.842Z", usage(1000, 0, 0, 100)),
    // Codex 会在同一轮重复上报，累计值不变；直接累加 last_token_usage 会重复计数。
    tokenCount("2026-08-06T03:40:46.842Z", usage(1000, 0, 0, 100)),
    tokenCount("2026-08-06T03:41:00.000Z", usage(2500, 0, 0, 300)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile);

  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.duplicateRecords, 1);
  assert.equal(parsed.events[0].totalTokens, 1100);
  assert.equal(parsed.events[1].totalTokens, 1700);
  assert.equal(parsed.events.reduce((t, e) => t + e.totalTokens, 0), 2800);
});

test("restarts the baseline when cumulative usage goes backwards", () => {
  const content = [
    JSON.stringify({ timestamp: "2026-08-06T03:40:32.888Z", type: "session_meta", payload: { session_id: "compact-1", cwd: "D:\\demo" } }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    tokenCount("2026-08-06T03:40:45.000Z", usage(5000, 0, 0, 500)),
    // /compact 后累计值回退，不能产生负增量
    tokenCount("2026-08-06T03:50:45.000Z", usage(800, 0, 0, 90)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile);

  assert.equal(parsed.events.length, 2);
  for (const event of parsed.events) {
    assert.ok(event.inputTokens >= 0, "input tokens must not go negative");
    assert.ok(event.outputTokens >= 0, "output tokens must not go negative");
  }
  assert.equal(parsed.events[1].totalTokens, 890);
});

test("counts invalid JSON lines without dropping valid usage", () => {
  const content = [
    "not-json",
    JSON.stringify({ timestamp: "2026-08-06T03:40:32.888Z", type: "session_meta", payload: { session_id: "s-9", cwd: "D:\\demo" } }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    tokenCount("2026-08-06T03:40:45.000Z", usage(700, 0, 0, 30)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile);

  assert.equal(parsed.invalidLines, 1);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].totalTokens, 730);
});

test("extracts conversation segments only when prompts are requested", () => {
  const content = [
    JSON.stringify({ timestamp: "2026-08-06T03:40:32.888Z", type: "session_meta", payload: { session_id: "seg-1", cwd: "D:\\demo" } }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复这个 bug" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已定位问题" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "Exit code: 0\nfile.js" } }),
    tokenCount("2026-08-06T03:40:45.000Z", usage(900, 0, 0, 60)),
  ].join("\n");

  const withoutPrompts = parseCodexRollout(content, logFile);
  assert.equal(withoutPrompts.prompts.size, 0, "sync path should not parse conversation text");

  const parsed = parseCodexRollout(content, logFile, { withPrompts: true });
  const segments = parsed.prompts.get(parsed.events[0].messageId);
  assert.ok(segments, "expected segments for the first turn");
  assert.deepEqual(segments.userSegments.map((s) => s.kind), ["text", "tool_result"]);
  assert.deepEqual(segments.assistantSegments.map((s) => s.kind), ["text", "tool_use"]);
  assert.equal(segments.userSegments[0].text, "修复这个 bug");
  assert.equal(segments.assistantSegments[1].name, "shell");
  assert.equal(segments.userSegments[1].isError, false);
});

test("flags non-zero tool exit codes as errors", () => {
  const content = [
    JSON.stringify({ timestamp: "2026-08-06T03:40:32.888Z", type: "session_meta", payload: { session_id: "err-1", cwd: "D:\\demo" } }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output: "Exit code: 1\ncommand failed" } }),
    tokenCount("2026-08-06T03:40:45.000Z", usage(500, 0, 0, 20)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile, { withPrompts: true });
  const segments = parsed.prompts.get(parsed.events[0].messageId);
  assert.ok(segments);
  assert.equal(segments.userSegments[0].isError, true);
});

test("encodes cwd the same way Claude encodes project directories", () => {
  // 同一项目在两个平台下必须得到相同 projectName，项目成本中心才会合并。
  assert.equal(encodeProjectName("D:\\python_code\\TokenTracker"), "D--python-code-TokenTracker");
  assert.equal(encodeProjectName("/home/dev/my_app"), "-home-dev-my-app");
  assert.equal(encodeProjectName(null), "unknown");
});

test("keeps the earliest timestamp as the session start", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-08-06T03:40:32.888Z",
      type: "session_meta",
      payload: { session_id: "ts-1", cwd: "D:\\demo", timestamp: "2026-08-06T03:38:45.732Z" },
    }),
    JSON.stringify({ timestamp: "2026-08-06T03:40:33.219Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
    tokenCount("2026-08-06T03:45:00.000Z", usage(400, 0, 0, 10)),
  ].join("\n");

  const parsed = parseCodexRollout(content, logFile);
  assert.equal(parsed.session.timestamp, "2026-08-06T03:38:45.732Z");
});
