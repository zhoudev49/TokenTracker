import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-server-"));
const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-log-"));
process.env.TOKEN_TRACKER_DATA_DIR = dataDirectory;
process.env.TOKEN_TRACKER_CLAUDE_PROJECTS_DIR = logDirectory;

// 注意：必须用 require（而非 import）加载被测模块——TS 的 import 会提升到文件顶部，
// 导致上方 TOKEN_TRACKER_* env 赋值失效（server.ts 在模块加载时读取 env）。
const { importLogFile, readCompleteChunk, syncClaudeLogs } = require("../src/server") as typeof import("../src/server");
const { closeDatabase, getImportedLogFiles, getSessionEvents, importedLogKey } = require("../src/database") as typeof import("../src/database");

test.after(async () => {
  await closeDatabase();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.rmSync(logDirectory, { recursive: true, force: true });
});

function makeLogLine(messageId: string, inputTokens: number): string {
  return `${JSON.stringify({
    session_id: "session-1",
    timestamp: "2026-08-06T00:00:00.000Z",
    message: {
      id: messageId,
      model: "model-a",
      usage: {
        input_tokens: inputTokens,
        output_tokens: 2,
      },
    },
  })}\n`;
}

test("rebuilds a log when its content changes without changing its size", async () => {
  const filePath = path.join(logDirectory, "session.jsonl");
  const storedPath = "project-a/session.jsonl";
  const firstContent = makeLogLine("message-1", 1);
  const secondContent = makeLogLine("message-2", 9);
  assert.equal(firstContent.length, secondContent.length);

  await fs.promises.writeFile(filePath, firstContent, "utf8");
  await importLogFile({
    filePath,
    storedPath,
    projectName: "project-a",
    sessionId: "session-1",
    modifiedTimeMs: 100,
    fileSize: firstContent.length,
  }, null);

  const previousState = (await getImportedLogFiles()).get(importedLogKey("claude", storedPath));
  await fs.promises.writeFile(filePath, secondContent, "utf8");
  await importLogFile({
    filePath,
    storedPath,
    projectName: "project-a",
    sessionId: "session-1",
    modifiedTimeMs: 200,
    fileSize: secondContent.length,
  }, previousState);

  const events = await getSessionEvents("session-1", "project-a");
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, "message-2");
  assert.equal(events[0].totalTokens, 11);
});

test("reads only complete lines across chunk boundaries", async () => {
  const filePath = path.join(logDirectory, "chunk-boundary.jsonl");
  const completeLine = `${"x".repeat(65_530)}\n`;
  const partialLine = "unfinished";
  await fs.promises.writeFile(filePath, completeLine + partialLine, "utf8");

  const result = await readCompleteChunk(
    filePath,
    0,
    Buffer.byteLength(completeLine + partialLine),
  );

  assert.equal(result.content, completeLine);
  assert.equal(result.nextOffset, Buffer.byteLength(completeLine));
});

test("syncs nested subagent logs into their parent session", async () => {
  const projectDirectory = path.join(logDirectory, "project-recursive");
  const subagentDirectory = path.join(
    projectDirectory,
    "session-recursive",
    "subagents",
  );
  const filePath = path.join(subagentDirectory, "agent-1.jsonl");
  await fs.promises.mkdir(subagentDirectory, { recursive: true });
  await fs.promises.writeFile(
    filePath,
    makeLogLine("message-subagent", 7).replace(
      '"session-1"',
      '"session-recursive"',
    ),
    "utf8",
  );

  const result = await syncClaudeLogs();
  const events = await getSessionEvents("session-recursive", "project-recursive");

  assert.equal(result.scannedFiles, 1);
  assert.equal(result.updatedFiles, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, "message-subagent");
  assert.equal(events[0].totalTokens, 9);
});

// ---------------------------------------------------------------------------
// 回归测试：末尾无换行的记录、平台隔离、空源保护
// ---------------------------------------------------------------------------

test("导入末尾没有换行符的最后一条记录", async () => {
  // 回归：readCompleteLines 只在遇到 '\n' 时推进偏移，EOF 处残留的缓冲区从不消费，
  // 导致「最后一条记录写完但没写换行」（进程被中断、日志被截断）时该条永久丢失，
  // 而且文件每次同步都被重新解析、永不进入 idle。
  const directory = path.join(logDirectory, "project-tail");
  await fs.promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "no-trailing-newline.jsonl");
  const first = makeLogLine("tail-message-1", 10);
  const second = makeLogLine("tail-message-2", 1500).trimEnd(); // 故意不带结尾换行
  await fs.promises.writeFile(filePath, first + second, "utf8");

  const firstSync = await syncClaudeLogs();
  const events = await getSessionEvents("session-1", "project-tail");
  const tailEvent = events.find((event) => event.messageId === "tail-message-2");

  assert.ok(tailEvent, "末尾无换行的记录也必须被导入");
  assert.equal(tailEvent!.totalTokens, 1502);
  assert.ok(firstSync.updatedFiles >= 1);

  // 该文件已被读到末尾，第二次同步应当走 unchanged 快路径（不再重解析）
  const secondSync = await syncClaudeLogs();
  assert.equal(secondSync.updatedFiles, 0, "消费掉末尾记录后不应再重复导入");
});

test("空文件不会在每次同步时被反复重建", async () => {
  // 回归：requiresRebuild 曾把 previous.fileSize === 0 当作「需要重建」，
  // 于是 0 字节的占位文件永远无法进入 idle，每次同步都 DELETE + 重新解析。
  const directory = path.join(logDirectory, "project-empty");
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, "empty.jsonl"), "", "utf8");

  const syncOnce = async () => {
    let updated = 0;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      const result = await syncClaudeLogs();
      updated = result.updatedFiles;
    }
    return updated;
  };

  await syncOnce(); // 首次会导入（记下状态）
  const secondPass = await syncOnce();
  assert.equal(secondPass, 0, "空文件一旦记录过状态，后续同步不应再重建");
});
