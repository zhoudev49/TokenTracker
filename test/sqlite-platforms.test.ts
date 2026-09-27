// SQLite 型平台（ZCode / OpenCode）与若干数据安全逻辑的测试。
// 这些用例此前完全缺失：两个 SQLite 解析器、只读打开语义、路径相对化迁移、CSV 转义。
//
// 注意：database.ts 在模块加载时读取 TOKEN_TRACKER_DATA_DIR，
// 因此必须先设置 env（见下）再用 require 加载被测模块——不要改成 import（会被提升）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-sqlite-"));
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-fixture-"));
process.env.TOKEN_TRACKER_DATA_DIR = dataDirectory;

const { readZCodeDatabase, zcodeFileInfo, loadZCodeProjectRealPaths } = require("../src/zcode-parser") as typeof import("../src/zcode-parser");
const { readOpenCodeDatabase, openCodeFileInfo, loadOpenCodeProjectRealPaths } = require("../src/opencode-parser") as typeof import("../src/opencode-parser");
const { rowsToCsv } = require("../src/analytics") as typeof import("../src/analytics");
const {
  initializeDatabase,
  processImportedChunk,
  getSessionSourceFiles,
  markLogFileImported,
  getImportedLogFiles,
  importedLogKey,
  migrateSourcePathsToRelative,
  closeDatabase,
} = require("../src/database") as typeof import("../src/database");

test.after(async () => {
  await closeDatabase();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

function runSql(databasePath: string, statements: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      database.serialize(() => {
        for (const statement of statements) database.run(statement);
        database.close((closeError) => closeError ? reject(closeError) : resolve());
      });
    });
  });
}

// ---------------------------------------------------------------------------
// ZCode
// ---------------------------------------------------------------------------

test("ZCode：input_tokens 含缓存时要剥离，四项相加等于 computed_total_tokens", async () => {
  const databasePath = path.join(fixtureDirectory, "zcode.sqlite");
  await runSql(databasePath, [
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)",
    "CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model_id TEXT NOT NULL, started_at INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, computed_total_tokens INTEGER, provider_total_tokens INTEGER)",
    "INSERT INTO session (id, directory) VALUES ('sess-1', '/Users/dev/proj/app')",
    // 真实样本：12834 已含缓存读 512，computed_total 14944
    "INSERT INTO model_usage VALUES ('u1', 'sess-1', 'glm-5.3-flash', 1786498102707, 12834, 2110, 0, 512, 14944, 14944)",
    // 全零记录不应入库
    "INSERT INTO model_usage VALUES ('u2', 'sess-1', 'glm-5.3-flash', 1786498102708, 0, 0, 0, 0, 0, 0)",
  ]);

  const parsed = await readZCodeDatabase(databasePath);
  assert.equal(parsed.events.length, 1, "零用量行应被跳过");

  const event = parsed.events[0];
  assert.equal(event.platform, "zcode");
  assert.equal(event.inputTokens, 12834 - 512, "含缓存的 input 应剥离出纯输入");
  assert.equal(event.outputTokens, 2110);
  assert.equal(event.cacheReadTokens, 512);
  assert.equal(event.cacheCreationTokens, 0);
  assert.equal(event.totalTokens, 14944, "四项相加应回到 computed_total_tokens");
  assert.equal(
    event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheCreationTokens,
    event.totalTokens,
  );
  assert.equal(event.model, "glm-5.3-flash");
  assert.equal(event.projectName, "-Users-dev-proj-app", "项目名应与 Claude 侧编码一致");
  assert.equal(event.sessionId, "sess-1");
  assert.equal(event.timestamp, new Date(1786498102707).toISOString());
});

test("ZCode：结构不符的库返回空结果而不是抛错", async () => {
  const databasePath = path.join(fixtureDirectory, "zcode-empty.sqlite");
  await runSql(databasePath, ["CREATE TABLE unrelated (id TEXT)"]);
  const parsed = await readZCodeDatabase(databasePath);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.usageRecords, 0);
});

test("ZCode：cwd 映射与文件签名（含 WAL 副文件）", async () => {
  const databasePath = path.join(fixtureDirectory, "zcode.sqlite");
  const realPaths = await loadZCodeProjectRealPaths(databasePath);
  assert.equal(realPaths.get("-Users-dev-proj-app"), "/Users/dev/proj/app");

  const info = zcodeFileInfo(databasePath);
  assert.ok(info);
  const baseSize = fs.statSync(databasePath).size;
  assert.equal(info!.fileSize, baseSize);

  // 写入一个 -wal 副文件：签名必须把它算进去，否则 WAL 模式下的新数据会被漏掉
  fs.writeFileSync(`${databasePath}-wal`, Buffer.alloc(128));
  const withWal = zcodeFileInfo(databasePath);
  assert.equal(withWal!.fileSize, baseSize + 128, "WAL 副文件大小应计入变更签名");

  assert.equal(zcodeFileInfo(path.join(fixtureDirectory, "nope.sqlite")), null);
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

test("OpenCode：reasoning 并入 output，input 不含缓存", async () => {
  const databasePath = path.join(fixtureDirectory, "opencode.sqlite");
  const message = {
    role: "assistant",
    modelID: "deepseek-v4-flash-free",
    path: { cwd: "/Users/dev/proj/app" },
    tokens: { total: 14051, input: 987, output: 156, reasoning: 236, cache: { read: 12672, write: 0 } },
    time: { created: 1786890823592, completed: 1786890828148 },
  };
  await runSql(databasePath, [
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, model TEXT, time_created INTEGER)",
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
    "INSERT INTO session VALUES ('ses_1', '/Users/dev/proj/app', '{\"id\":\"deepseek-v4-flash-free\"}', 1786890000000)",
    `INSERT INTO message VALUES ('msg_1', 'ses_1', '${JSON.stringify(message)}')`,
    // 没有 tokens 字段的消息应被跳过
    `INSERT INTO message VALUES ('msg_2', 'ses_1', '${JSON.stringify({ role: "user" })}')`,
    // 全零 tokens 也应被跳过
    `INSERT INTO message VALUES ('msg_3', 'ses_1', '${JSON.stringify({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })}')`,
  ]);

  const parsed = await readOpenCodeDatabase(databasePath);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.invalidLines, 0);

  const event = parsed.events[0];
  assert.equal(event.platform, "opencode");
  assert.equal(event.inputTokens, 987, "OpenCode 的 input 不含缓存读");
  assert.equal(event.outputTokens, 156 + 236, "reasoning 应并入 output");
  assert.equal(event.cacheReadTokens, 12672);
  assert.equal(event.totalTokens, 987 + 156 + 236 + 12672);
  assert.equal(event.model, "deepseek-v4-flash-free");
  assert.equal(event.projectName, "-Users-dev-proj-app");
  assert.equal(event.timestamp, new Date(1786890828148).toISOString());
});

test("OpenCode：data 不是合法 JSON 时计入 invalidLines 而不是抛错", async () => {
  const databasePath = path.join(fixtureDirectory, "opencode-bad.sqlite");
  await runSql(databasePath, [
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, model TEXT, time_created INTEGER)",
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
    "INSERT INTO session VALUES ('ses_1', '/tmp/proj', NULL, 1)",
    "INSERT INTO message VALUES ('msg_1', 'ses_1', 'not-json')",
  ]);
  const parsed = await readOpenCodeDatabase(databasePath);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.invalidLines, 1);
});

test("OpenCode：cwd 映射与文件签名", async () => {
  const databasePath = path.join(fixtureDirectory, "opencode.sqlite");
  const realPaths = await loadOpenCodeProjectRealPaths(databasePath);
  assert.equal(realPaths.get("-Users-dev-proj-app"), "/Users/dev/proj/app");
  const info = openCodeFileInfo(databasePath);
  assert.ok(info);
  assert.equal(info!.storedPath, "opencode.sqlite", "只存文件名，不泄露绝对路径");
  assert.equal(openCodeFileInfo(path.join(fixtureDirectory, "nope.sqlite")), null);
});

// ---------------------------------------------------------------------------
// 只读语义
// ---------------------------------------------------------------------------

test("第三方数据库必须以只读方式打开：不存在的库不会被凭空创建", async () => {
  const missing = path.join(fixtureDirectory, "should-not-be-created.sqlite");
  await assert.rejects(() => readOpenCodeDatabase(missing));
  assert.equal(fs.existsSync(missing), false, "只读打开失败时绝不能创建文件");
});

// ---------------------------------------------------------------------------
// 隐私：路径相对化迁移
// ---------------------------------------------------------------------------

test("路径迁移：只改写位于该根目录下的绝对路径，域外路径保持原样", async () => {
  await initializeDatabase();
  const claudeRoot = path.join(os.tmpdir(), "fake-claude-projects");
  const insidePath = path.join(claudeRoot, "Projects-App", "session-1.jsonl");
  const outsidePath = "/somewhere/else/data.jsonl";
  const projectName = `migrate-${Date.now()}`;

  await markLogFileImported(insidePath, { modifiedTimeMs: 1, fileSize: 10, byteOffset: 10, status: "ready", platform: "claude" });
  await markLogFileImported(outsidePath, { modifiedTimeMs: 1, fileSize: 10, byteOffset: 10, status: "ready", platform: "claude" });

  await migrateSourcePathsToRelative(claudeRoot);

  const imported = await getImportedLogFiles();
  // imported_logs 的键是 `platform\0file_path`：不同平台的相对路径会重名，必须带平台前缀。
  assert.ok(imported.has(importedLogKey("claude", "Projects-App/session-1.jsonl")), "根目录下的绝对路径应改写为相对路径");
  assert.equal(imported.has(importedLogKey("claude", insidePath)), false, "旧的绝对路径行应被清理");
  assert.ok(imported.has(importedLogKey("claude", outsidePath)), "不属于该根目录的绝对路径必须保持原样（否则会被改写成 ../../…）");

  // usage_events.source_file 同样要被相对化
  await processImportedChunk(
    { sessionId: projectName, projectName, timestamp: null, model: null },
    [{
      eventKey: `migrate\0${projectName}\0${projectName}\0m1`,
      sourceFile: insidePath,
      messageId: "m1",
      sessionId: projectName,
      projectName,
      timestamp: "2026-09-19T00:00:00.000Z",
      model: "glm-5.3",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 2,
    }],
  );
  await migrateSourcePathsToRelative(claudeRoot);
  // source_file 不在 queryUsageEvents 的返回里（它是内部字段），用 getSessionSourceFiles 取
  const sourceFiles = await getSessionSourceFiles(projectName, projectName);
  assert.deepEqual(sourceFiles, ["Projects-App/session-1.jsonl"], "事件来源路径也应相对化，避免写入用户名");
});

// ---------------------------------------------------------------------------
// CSV 输出
// ---------------------------------------------------------------------------

test("CSV：表头带 BOM，字段含逗号/引号/换行时正确转义", () => {
  const csv = rowsToCsv(
    [{ a: 'say "hi", ok', b: "line1\nline2" }],
    [{ key: "a", label: "A" }, { key: "b", label: "B" }],
  );
  assert.ok(csv.startsWith("\uFEFF"), "应带 BOM 以便 Excel 正确识别 UTF-8");
  assert.ok(csv.includes('"say ""hi"", ok"'));
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.endsWith("\r\n"), "应使用 CRLF 行尾");
});

test("CSV：以 = + - @ 开头的单元格加单引号，防止公式注入", () => {
  const csv = rowsToCsv(
    [{ a: "=cmd|'/c calc'!A1", b: "+1", c: "-2", d: "@SUM(A1)", e: "safe" }],
    [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }, { key: "d", label: "D" }, { key: "e", label: "E" }],
  );
  const dataLine = csv.split("\r\n")[1];
  assert.ok(dataLine.includes("'=cmd"), "= 前缀未转义");
  assert.ok(dataLine.includes("'+1"), "+ 前缀未转义");
  assert.ok(dataLine.includes("'-2"), "- 前缀未转义");
  assert.ok(dataLine.includes("'@SUM(A1)"), "@ 前缀未转义");
  assert.ok(dataLine.endsWith(",safe"), "普通值不应被改动");
});

// ---------------------------------------------------------------------------
// 数据安全：源不可读时不得清空已导入的历史
// ---------------------------------------------------------------------------

test("源库表缺失时不得删除已导入的用量（重建路径先删后插的防护）", async () => {
  // 回归：rebuild 平台是「先删、再解析、再插入」。当源库的预期表读不到时，
  // 读取器会「成功返回空数组」而不抛错，于是删除清空了此前导入的全部事件，
  // 文件随即被标记 ready，再也不重试 —— 用户历史被不可逆销毁。
  const platformDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-zcode-guard-"));
  const databasePath = path.join(platformDirectory, "guard.sqlite");
  process.env.TOKEN_TRACKER_ZCODE_DB = databasePath;

  // 因为 platforms.ts 在 require 时读取 env，这里必须清掉模块缓存后重新加载，
  // 才能让 ZCode 适配器指向本次的临时库。
  const adapterPath = require.resolve("../src/platforms");
  const serverPath = require.resolve("../src/server");
  for (const modulePath of Object.keys(require.cache)) {
    if (modulePath.includes(`${path.sep}dist${path.sep}src${path.sep}`)) delete require.cache[modulePath];
  }
  const { getAdapter } = require(adapterPath) as typeof import("../src/platforms");
  const { syncPlatform } = require(serverPath) as typeof import("../src/server");

  const modelUsageSchema = [
    "CREATE TABLE session (id TEXT, directory TEXT)",
    `CREATE TABLE model_usage (
       id INTEGER PRIMARY KEY, session_id TEXT, model_id TEXT, started_at TEXT,
       input_tokens INTEGER, output_tokens INTEGER, cache_creation_input_tokens INTEGER,
       cache_read_input_tokens INTEGER, computed_total_tokens INTEGER, provider_total_tokens INTEGER)`,
    "INSERT INTO session VALUES ('guard-session', '/Users/dev/guard')",
    `INSERT INTO model_usage
       (session_id, model_id, started_at, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, provider_total_tokens)
     VALUES ('guard-session','model-a','2026-09-01T00:00:00Z',100,50,0,0,150,150)`,
  ];

  await runSql(databasePath, modelUsageSchema);
  await syncPlatform("zcode");
  const { getUsageEventCount } = require("../src/database") as typeof import("../src/database");
  const afterHealthySync = await getUsageEventCount("zcode");
  assert.equal(afterHealthySync, 1, "健康源库应导入 1 条事件");

  // 源库的 model_usage 表消失（工具升级 / 库损坏 / 读到半截）
  await runSql(databasePath, ["DROP TABLE model_usage"]);
  const state = await syncPlatform("zcode");

  assert.equal(
    await getUsageEventCount("zcode"),
    afterHealthySync,
    "源库不可读时必须保留已导入的事件，而不是先删后插清空",
  );
  assert.equal(state.failedFiles, 1, "该文件应被记为失败，以便下次同步重试");

  fs.rmSync(platformDirectory, { recursive: true, force: true });
});
