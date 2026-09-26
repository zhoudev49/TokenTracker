// 新平台解析器测试：Claude 形态 JSONL（WorkBuddy / CodeBuddy / Qoder / Qwen）
// 与两个 SQLite 型平台（ZCode / OpenCode）的入口归一逻辑。
//
// 重点是各家 token 口径不一致这件事：OpenAI 系上报的 input/prompt_tokens
// **已包含**缓存读，直接入库会让「四项相加 = 总量」不成立，必须剥离缓存。

import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeJsonlParser, parseClaudeJsonlFile, readUsageSnapshot } from "../src/claude-jsonl-parser";
import { encodeProjectName, normalizeTimestamp, sessionIdFromFileName } from "../src/platform-adapter";
import { describeAdapters, getAdapter, listAdapters } from "../src/platforms";
import type { PlatformFileInfo } from "../src/platform-adapter";

function makeFile(overrides: Partial<PlatformFileInfo> = {}): PlatformFileInfo {
  return {
    filePath: "/tmp/fake/session.jsonl",
    storedPath: "Projects-Demo/session-1.jsonl",
    projectName: "Projects-Demo",
    sessionId: "session-1",
    modifiedTimeMs: 0,
    fileSize: 0,
    ...overrides,
  };
}

function parseLines(lines: unknown[], options: Parameters<typeof parseClaudeJsonlFile>[3] = {}) {
  return parseClaudeJsonlFile(lines.map((line) => JSON.stringify(line)).join("\n"), makeFile(), "workbuddy", options);
}

test("WorkBuddy 形态：input_tokens 含缓存时剥离出纯输入，四项相加等于总量", () => {
  // 真实样本（已用本机日志核对）：prompt_cache_hit 7168 + prompt_cache_miss 26071 = 33239 input_tokens
  const parsed = parseLines([
    {
      id: "rec-1",
      sessionId: "session-1",
      timestamp: 1789795014387,
      type: "function_call",
      providerData: { model: "deepseek-v4.1-flash" },
      message: {
        usage: {
          input_tokens: 33239,
          output_tokens: 382,
          total_tokens: 33621,
          cache_read_input_tokens: 7168,
        },
      },
    },
  ]);

  assert.equal(parsed.events.length, 1);
  const event = parsed.events[0];
  assert.equal(event.inputTokens, 33239 - 7168, "纯输入应为 input_tokens 减去缓存读");
  assert.equal(event.outputTokens, 382);
  assert.equal(event.cacheReadTokens, 7168);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.totalTokens, 33621, "四项相加应回到上报总量");
  assert.equal(
    event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheCreationTokens,
    event.totalTokens,
  );
  assert.equal(event.model, "deepseek-v4.1-flash", "模型名应回退到 providerData.model");
  assert.equal(event.platform, "workbuddy");
  assert.equal(event.timestamp, new Date(1789795014387).toISOString(), "毫秒时间戳应被正确解析");
});

test("Claude 形态：input_tokens 不含缓存时保持原值（不做减法）", () => {
  const parsed = parseLines([
    {
      message: {
        id: "msg-1",
        model: "claude-3-5-sonnet-20241022",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 30,
        },
      },
    },
  ]);

  const event = parsed.events[0];
  assert.equal(event.inputTokens, 100);
  assert.equal(event.outputTokens, 50);
  assert.equal(event.cacheReadTokens, 900);
  assert.equal(event.cacheCreationTokens, 30);
  assert.equal(event.totalTokens, 1080);
});

test("零用量记录不入库，也不污染重复计数", () => {
  const parsed = parseLines([
    { id: "a", sessionId: "s", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { id: "b", sessionId: "s", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  ]);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].messageId, "b");
  assert.equal(parsed.usageRecords, 2);
  assert.equal(parsed.duplicateRecords, 0);
});

test("同一 message id 重复上报时保留最后一次（快照更新）", () => {
  const parsed = parseLines([
    { id: "same", sessionId: "s", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { id: "same", sessionId: "s", message: { usage: { input_tokens: 20, output_tokens: 2 } } },
  ]);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].totalTokens, 22);
  assert.equal(parsed.duplicateRecords, 1);
});

test("Qoder 的 model.response.completed 事件：从 data 字段取用量", () => {
  const file = makeFile({ storedPath: "logs/sessions/session-9/segments/1.jsonl", projectName: "Projects-Demo" });
  const parser = createClaudeJsonlParser(file, "qoder", {
    extraUsageFromRecord: (record) => {
      const type = typeof record.type === "string" ? record.type : "";
      return type.startsWith("model.response") ? record.data : null;
    },
  });
  parser.addLine(JSON.stringify({
    id: "evt-1",
    sessionId: "session-9",
    timestamp: "2026-09-01T00:00:00.000Z",
    type: "model.response.completed",
    data: {
      input_tokens: 2450,
      output_tokens: 380,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 0,
    },
  }));
  const parsed = parser.finish();

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].inputTokens, 2450, "无 total_tokens 时按不含缓存口径处理");
  assert.equal(parsed.events[0].cacheReadTokens, 1200);
  assert.equal(parsed.events[0].totalTokens, 4030);
});

test("ZCode 形态的 usage 归一（camelCase + 含缓存输入）", () => {
  // 真实样本：input 12834 / output 2110 / cacheRead 512 / computedTotal 14944
  const normalized = readUsageSnapshot({
    inputTokens: 12834,
    outputTokens: 2110,
    cacheReadTokens: 512,
    cacheWriteTokens: 0,
    totalTokens: 14944,
  });
  assert.ok(normalized);
  assert.equal(normalized!.inputTokens, 12834 - 512);
  assert.equal(normalized!.cacheReadTokens, 512);
  assert.equal(normalized!.totalTokens, 14944);
});

test("缓存读只出现在 inputTokensDetails 里时也能补出来", () => {
  const parsed = parseLines([
    {
      id: "detail-1",
      sessionId: "s",
      providerData: {
        usage: { requests: 1, inputTokens: 33239, outputTokens: 382, totalTokens: 33621, inputTokensDetails: [{ cached_tokens: 7168 }] },
      },
    },
  ]);
  const event = parsed.events[0];
  assert.equal(event.cacheReadTokens, 7168);
  assert.equal(event.inputTokens, 33239 - 7168);
  assert.equal(event.totalTokens, 33621);
});

test("会话详情：user / assistant 分段按 message id 配对", () => {
  const file = makeFile();
  const parser = createClaudeJsonlParser(file, "workbuddy", { withPrompts: true });
  const lines = [
    { type: "message", role: "user", content: "帮我看看这个报错", sessionId: "session-1" },
    { type: "reasoning", sessionId: "session-1", providerData: { reasoning: "先定位堆栈" } },
    { type: "function_call", id: "call-1", name: "Bash", arguments: { command: "ls" }, sessionId: "session-1",
      message: { usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 } } },
  ];
  for (const line of lines) parser.addLine(JSON.stringify(line));
  const parsed = parser.finish();

  assert.equal(parsed.events.length, 1);
  const segments = parsed.prompts!.get("call-1");
  assert.ok(segments);
  assert.equal(segments!.userSegments[0].text, "帮我看看这个报错");
  assert.equal(segments!.assistantSegments[0].kind, "thinking");
  assert.equal(segments!.assistantSegments[0].text, "先定位堆栈");
  assert.equal(segments!.assistantSegments[1].kind, "tool_use");
  assert.equal(segments!.assistantSegments[1].name, "Bash");
});

test("测试环境下未提供 usage 的文件不产生事件", () => {
  const parsed = parseLines([
    { id: "x", sessionId: "s", type: "message", role: "user", content: "hi" },
  ]);
  assert.equal(parsed.events.length, 0);
});

test("项目名编码与 Codex 侧保持一致（同一 cwd 归并到同一 projectName）", () => {
  assert.equal(encodeProjectName("/Users/dev/Projects/my_app"), "-Users-dev-Projects-my-app");
  assert.equal(encodeProjectName("C:\\Users\\ZT\\proj"), "C--Users-ZT-proj");
});

test("时间戳同时兼容 ISO 字符串、毫秒与秒级整数", () => {
  assert.equal(normalizeTimestamp("2026-09-19T05:00:00.000Z"), "2026-09-19T05:00:00.000Z");
  // 毫秒与秒级 epoch 都按 UTC 归一为 ISO 字符串
  assert.equal(normalizeTimestamp(1789795014387), new Date(1789795014387).toISOString());
  assert.equal(normalizeTimestamp(1789795014), new Date(1789795014000).toISOString());
  assert.equal(normalizeTimestamp(""), null);
  assert.equal(normalizeTimestamp("not-a-date"), null);
});

test("会话 id 从文件名推导（去掉 session- 前缀）", () => {
  assert.equal(sessionIdFromFileName("b3a1c6c8-6f1a-46af-b645-d3b5ea482b60.jsonl"), "b3a1c6c8-6f1a-46af-b645-d3b5ea482b60");
  assert.equal(sessionIdFromFileName("session-b363da51-4430-4703-90bc-7cc6c1fc7d67.jsonl"), "b363da51-4430-4703-90bc-7cc6c1fc7d67");
});

test("注册表包含全部已适配平台，且可按 id 取到适配器", () => {
  const ids = describeAdapters().map((item) => item.id);
  for (const expected of ["claude", "codex", "workbuddy", "codebuddy", "qoder", "qwen", "zcode", "opencode"]) {
    assert.ok(ids.includes(expected), `注册表应包含 ${expected}`);
  }
  for (const adapter of listAdapters()) {
    assert.equal(getAdapter(adapter.id)!.id, adapter.id);
    assert.ok(["incremental", "rebuild"].includes(adapter.mode));
    assert.ok(typeof adapter.label === "string" && adapter.label.length > 0);
    assert.ok(typeof adapter.envVar === "string" && adapter.envVar.startsWith("TOKEN_TRACKER_"));
  }
  assert.equal(getAdapter("not-a-platform"), null);
});

test("增量平台提供流式解析器，重建平台不提供", () => {
  assert.equal(getAdapter("claude")!.mode, "incremental");
  assert.equal(typeof getAdapter("claude")!.createIncrementalParser, "function");
  assert.equal(typeof getAdapter("workbuddy")!.createIncrementalParser, "function");
  assert.equal(getAdapter("codex")!.mode, "rebuild");
  assert.equal(getAdapter("opencode")!.mode, "rebuild");
});
