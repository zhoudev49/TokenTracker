// SQLite 建表、读写、增量同步状态。全部语句共用一条连接，
// 事务经 withTransaction 的 promise 队列串行执行。
import * as fs from "fs";
import * as path from "path";
import { AsyncLocalStorage } from "async_hooks";
import sqlite3 = require("sqlite3");
import type {
  EventFilters,
  FilterOptions,
  ImportDiagnostic,
  ImportedLogState,
  Pagination,
  SessionRef,
  SessionRow,
  SessionSummary,
  UsageEvent,
} from "./types";

const sqlite = sqlite3.verbose();

/**
 * 单条语句绑定参数的上限。SQLite 默认 SQLITE_MAX_VARIABLE_NUMBER = 32766，
 * 这里留出余量，避免依赖具体编译选项。
 */
const MAX_SQL_VARIABLES = 30000;

const dataDirectory: string = process.env.TOKEN_TRACKER_DATA_DIR
  ? path.resolve(process.env.TOKEN_TRACKER_DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
const databasePath: string = path.join(dataDirectory, "token-tracker.db");

let database: sqlite3.Database | null = null;
let initializationPromise: Promise<void> | null = null;

function openDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    database = new sqlite.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      database!.configure("busyTimeout", 5000);
      resolve();
    });
  });
}

interface RunResult { id: number; changes: number }

function run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    database!.run(sql, parameters, function handleResult(this: { lastID: number; changes: number }, error: Error | null) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// 所有语句共用一条 sqlite 连接，多个平台的同步是并发的，
// 因此事务必须排队执行，否则会出现 "cannot start a transaction within a transaction"。
let transactionQueue: Promise<unknown> = Promise.resolve();

// 标记「当前异步上下文正位于某个事务体内」。
// 必须用 AsyncLocalStorage 而不是一个布尔量：并发的另一个平台调用者并不在
// 本事务的上下文里，它应该排队等本事务结束，而不是被误并入本事务一起回滚。
const inTransactionContext = new AsyncLocalStorage<true>();

function withTransaction<T>(work: () => Promise<T>): Promise<T> {
  // 可重入：已经在事务里的调用直接加入当前事务。
  // 若在这里再次排队，内层会等待外层释放队列，而外层正在等内层 —— 永久死锁。
  if (inTransactionContext.getStore()) {
    return work();
  }

  const result = transactionQueue.then(async () => {
    await run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const value = await inTransactionContext.run(true, work);
      await run("COMMIT");
      return value;
    } catch (error) {
      try {
        await run("ROLLBACK");
      } catch {
        // ROLLBACK 自身失败（例如 SQLITE_FULL 时 SQLite 已自动回滚）不能覆盖真正的错误原因。
      }
      throw error;
    }
  });
  transactionQueue = result.catch(() => {});
  return result;
}

function all<T = any>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database!.all(sql, parameters, (error: Error | null, rows: T[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function get<T = any>(sql: string, parameters: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    database!.get(sql, parameters, (error: Error | null, row: T) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function normalizeTokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/**
 * imported_logs 的内存索引键：platform 与相对路径都可能含任意字符，
 * 用 NUL 分隔（与 event_key 的命名空间约定一致），避免拼接歧义。
 */
function importedLogKey(platform: string, filePath: string): string {
  return `${platform}\0${filePath}`;
}

function getLocalDateRange(value: unknown): [string, string] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return null;
  }
  const start = new Date(`${String(value)}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return null;
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

interface ColumnInfoRow { name: string }

async function addColumnIfMissing(tableName: string, columnName: string, definition: string): Promise<void> {
  const columns = await all<ColumnInfoRow>(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  try {
    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    // 先查后改不是原子的：两个进程（例如 npm run dev 与 npm start 共用同一 data 目录）
    // 可能同时判定「列不存在」并各自 ALTER，后到者会收到 duplicate column name。
    // 这属于良性竞争（列已经存在，正是我们想要的结果），不应让启动失败。
    if (!/duplicate column name/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

/**
 * 把 imported_logs 的主键从 (file_path) 升级为 (file_path, platform)。
 *
 * 旧库里 file_path 是唯一主键，而 file_path 存的是**相对各平台根目录**的路径 ——
 * `~/.claude/projects/<编码目录>/<会话>.jsonl` 与
 * `~/.workbuddy/projects/<编码目录>/<会话>.jsonl` 会得到完全相同的字符串。
 * 两个平台因此在同一行上互相覆盖，且 `deleteUsageEventsForFile` 会连带删掉对方的用量。
 *
 * SQLite 不支持修改主键，只能重建表。整段包在一个事务里，避免中途失败留下半张表。
 */
async function migrateImportedLogsPrimaryKey(): Promise<void> {
  const columns = await all<{ name: string; pk: number }>("PRAGMA table_info(imported_logs)");
  const primaryKeyColumns = columns.filter((column) => Number(column.pk) > 0).map((column) => column.name);
  const alreadyMigrated =
    primaryKeyColumns.length === 2 &&
    primaryKeyColumns.includes("file_path") &&
    primaryKeyColumns.includes("platform");
  if (alreadyMigrated) {
    return;
  }

  await run(`
    CREATE TABLE IF NOT EXISTS imported_logs_migrated (
      file_path TEXT NOT NULL,
      modified_time_ms REAL NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      platform TEXT NOT NULL DEFAULT 'claude',
      PRIMARY KEY (file_path, platform)
    )
  `);
  // 旧主键是 file_path 单列，因此每个 file_path 至多一行，
  // 迁移后 (file_path, platform) 天然唯一，直接搬运即可。
  await run(`
    INSERT INTO imported_logs_migrated (
      file_path, modified_time_ms, file_size, byte_offset,
      last_sync_at, status, error, platform
    )
    SELECT file_path, modified_time_ms, file_size, byte_offset,
           last_sync_at, status, error, platform
    FROM imported_logs
  `);
  await run("DROP TABLE imported_logs");
  await run("ALTER TABLE imported_logs_migrated RENAME TO imported_logs");
}

async function initializeDatabase(): Promise<void> {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
    await openDatabase();
    await run("PRAGMA journal_mode = WAL");
    await run("PRAGMA foreign_keys = ON");
    await run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        timestamp TEXT,
        model TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, project_name)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS imported_logs (
        file_path TEXT NOT NULL,
        modified_time_ms REAL NOT NULL,
        platform TEXT NOT NULL DEFAULT 'claude',
        PRIMARY KEY (file_path, platform)
      )
    `);
    await addColumnIfMissing("imported_logs", "file_size", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("imported_logs", "byte_offset", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("imported_logs", "last_sync_at", "TEXT");
    await addColumnIfMissing("imported_logs", "status", "TEXT NOT NULL DEFAULT 'ready'");
    await addColumnIfMissing("imported_logs", "error", "TEXT");
    await addColumnIfMissing("imported_logs", "platform", "TEXT NOT NULL DEFAULT 'claude'");
    await migrateImportedLogsPrimaryKey();
    // sessions 早期只有 (session_id, project_name, timestamp, model)，token 五列是后加的。
    // 这里必须补齐：否则老库上 initializeDatabase 会「成功」，直到导入中途
    // refreshSessionTotals 才报 "table sessions has no column named total_tokens"，
    // 平台同步整批失败，而文档承诺的是「既有数据库原地升级」。
    await addColumnIfMissing("sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("sessions", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    await addColumnIfMissing("sessions", "cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
    await run(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        source_file TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        timestamp TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        platform TEXT NOT NULL DEFAULT 'claude',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await addColumnIfMissing("usage_events", "platform", "TEXT NOT NULL DEFAULT 'claude'");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp)");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model)");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project_name)");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id, project_name)");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source_file)");
    await run("CREATE INDEX IF NOT EXISTS idx_usage_events_platform ON usage_events(platform)");
    await run("PRAGMA user_version = 2");
  })().catch(async (error) => {
    // 初始化失败必须把已打开的连接关掉再抛出：initializationPromise 会被清空，
    // 下次请求会重试并再次 open，若不关闭就会每次失败泄漏一个连接（含 WAL/-shm 句柄与锁），
    // 最终耗尽文件描述符，并让数据库文件被永久占用。
    initializationPromise = null;
    const dying = database;
    database = null;
    if (dying) {
      await new Promise<void>((resolve) => dying.close(() => resolve()));
    }
    throw error;
  });

  return initializationPromise;
}

async function upsertSessionMetadata(session: SessionSummary | null | undefined): Promise<void> {
  if (!session || !session.sessionId || !session.projectName) {
    return;
  }

  await run(
    `
      INSERT INTO sessions (session_id, project_name, timestamp, model)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, project_name) DO UPDATE SET
        timestamp = CASE
          WHEN sessions.timestamp IS NULL THEN excluded.timestamp
          WHEN excluded.timestamp IS NULL THEN sessions.timestamp
          WHEN excluded.timestamp < sessions.timestamp THEN excluded.timestamp
          ELSE sessions.timestamp
        END,
        model = COALESCE(sessions.model, excluded.model)
    `,
    [String(session.sessionId), String(session.projectName), session.timestamp || null, session.model || null],
  );
}

async function upsertUsageEvents(events: UsageEvent[]): Promise<number> {
  await initializeDatabase();
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  return withTransaction(async () => {
    for (const event of events) {
      await run(
        `
          INSERT INTO usage_events (
            event_key, source_file, message_id, session_id, project_name,
            timestamp, model, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, total_tokens, platform, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(event_key) DO UPDATE SET
            source_file = excluded.source_file,
            timestamp = excluded.timestamp,
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            total_tokens = excluded.total_tokens,
            platform = excluded.platform,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
          event.eventKey,
          event.sourceFile,
          event.messageId,
          event.sessionId,
          event.projectName,
          event.timestamp || null,
          event.model || null,
          normalizeTokenCount(event.inputTokens),
          normalizeTokenCount(event.outputTokens),
          normalizeTokenCount(event.cacheReadTokens),
          normalizeTokenCount(event.cacheCreationTokens),
          normalizeTokenCount(event.totalTokens),
          event.platform || "claude",
        ],
      );
    }
    return events.length;
  });
}

interface SessionAggregateRow {
  first_timestamp: string | null;
  model_count: number;
  single_model: string | null;
  real_model_count: number;
  single_real_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

async function refreshSessionTotals(sessionId: string, projectName: string): Promise<void> {
  await initializeDatabase();
  const aggregate = await get<SessionAggregateRow>(
    `
      SELECT
        MIN(timestamp) AS first_timestamp,
        COUNT(DISTINCT COALESCE(model, 'unknown')) AS model_count,
        MIN(COALESCE(model, 'unknown')) AS single_model,
        COUNT(DISTINCT CASE WHEN model IS NOT NULL AND model NOT IN ('unknown', '<synthetic>', '') THEN model END) AS real_model_count,
        MIN(CASE WHEN model IS NOT NULL AND model NOT IN ('unknown', '<synthetic>', '') THEN model END) AS single_real_model,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_events
      WHERE session_id = ? AND project_name = ?
    `,
    [sessionId, projectName],
  );

  await run(
    `
      INSERT INTO sessions (
        session_id, project_name, timestamp, model, total_tokens,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, project_name) DO UPDATE SET
        timestamp = COALESCE(excluded.timestamp, sessions.timestamp),
        model = excluded.model,
        total_tokens = excluded.total_tokens,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens
    `,
    [
      sessionId,
      projectName,
      aggregate.first_timestamp || null,
      aggregate.real_model_count > 1 ? "multiple" : (aggregate.real_model_count === 1 ? aggregate.single_real_model : (aggregate.single_model || "unknown")),
      aggregate.total_tokens,
      aggregate.input_tokens,
      aggregate.output_tokens,
      aggregate.cache_read_tokens,
      aggregate.cache_creation_tokens,
    ],
  );
}

async function processImportedChunk(session: SessionSummary | null | undefined, events: UsageEvent[]): Promise<void> {
  await initializeDatabase();
  await upsertSessionMetadata(session);
  await upsertUsageEvents(events);
  const affectedSessions = new Map<string, { sessionId: string; projectName: string }>();

  if (session && session.sessionId && session.projectName) {
    affectedSessions.set(`${session.projectName}\0${session.sessionId}`, session);
  }
  for (const event of events) {
    affectedSessions.set(`${event.projectName}\0${event.sessionId}`, event);
  }
  for (const item of affectedSessions.values()) {
    await refreshSessionTotals(item.sessionId, item.projectName);
  }
}

function buildEventConditions(filters: EventFilters = {}, alias = ""): { conditions: string[]; parameters: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  const conditions: string[] = [];
  const parameters: unknown[] = [];

  if (filters.date) {
    const range = getLocalDateRange(filters.date);
    if (!range) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`${prefix}timestamp >= ? AND ${prefix}timestamp < ?`);
      parameters.push(...range);
    }
  }
  if (filters.startDate) {
    const range = getLocalDateRange(filters.startDate);
    if (!range) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`${prefix}timestamp >= ?`);
      parameters.push(range[0]);
    }
  }
  if (filters.endDate) {
    const range = getLocalDateRange(filters.endDate);
    if (!range) {
      conditions.push("1 = 0");
    } else {
      conditions.push(`${prefix}timestamp < ?`);
      parameters.push(range[1]);
    }
  }
  if (filters.model) {
    conditions.push(`${prefix}model = ?`);
    parameters.push(filters.model);
  }
  if (filters.projectName) {
    conditions.push(`${prefix}project_name = ?`);
    parameters.push(filters.projectName);
  }
  if (filters.sessionId) {
    conditions.push(`${prefix}session_id = ?`);
    parameters.push(filters.sessionId);
  }
  if (filters.search) {
    const escaped = String(filters.search).replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    conditions.push(`(${prefix}session_id LIKE ? ESCAPE '\\' OR ${prefix}project_name LIKE ? ESCAPE '\\' OR COALESCE(${prefix}model, 'unknown') LIKE ? ESCAPE '\\')`);
    parameters.push(pattern, pattern, pattern);
  }
  if (filters.platform) {
    conditions.push(`${prefix}platform = ?`);
    parameters.push(filters.platform);
  }
  return { conditions, parameters };
}

function buildEventSelect(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `
    ${prefix}event_key AS eventKey,
    ${prefix}session_id AS sessionId,
    ${prefix}project_name AS projectName,
    ${prefix}message_id AS messageId,
    ${prefix}timestamp,
    ${prefix}model,
    ${prefix}input_tokens AS inputTokens,
    ${prefix}output_tokens AS outputTokens,
    ${prefix}cache_read_tokens AS cacheReadTokens,
    ${prefix}cache_creation_tokens AS cacheCreationTokens,
    ${prefix}total_tokens AS totalTokens,
    ${prefix}platform
  `;
}

function getPagination(filters: Record<string, unknown> = {}): Pagination {
  // Number.isFinite 而不是 `|| 1`：Number("Infinity") 是 truthy，`|| 1` 不会兜底，
  // 于是 offset 变成 Infinity 被绑进 LIMIT/OFFSET，报 SQLITE_MISMATCH（未处理的 500），
  // 而且 page 会被 JSON.stringify 序列化成 null，破坏分页契约。
  const rawPage = Math.trunc(Number(filters.page));
  const page = Number.isFinite(rawPage) ? Math.min(1_000_000, Math.max(1, rawPage)) : 1;
  const rawPageSize = Math.trunc(Number(filters.pageSize));
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(200, Math.max(1, rawPageSize)) : 50;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function getSortClause(sort: string, direction: string, allowed: Record<string, string>, fallback: string): string {
  // 必须是「自有属性」判断：`allowed[sort]` 会走原型链，
  // 于是 ?sort=constructor / toString / valueOf / __proto__ 会把一个**函数**当成字段名
  // 插进 ORDER BY，产生 `ORDER BY function Object() {...}` 的 SQL 语法错误 500。
  const field = Object.prototype.hasOwnProperty.call(allowed, sort) ? allowed[sort] : fallback;
  const order = String(direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  return `${field} ${order}`;
}

interface QueryOptions {
  alias?: string;
  from?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

async function queryUsageEvents(filters: EventFilters = {}, options: QueryOptions = {}): Promise<UsageEvent[]> {
  await initializeDatabase();
  const { conditions, parameters } = buildEventConditions(filters, options.alias || "");
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = options.orderBy || "timestamp DESC";
  // 追加一个唯一列作为并列时的兜底排序键：ORDER BY 的键不唯一时，
  // SQLite 对并列行的返回顺序是不确定的，分页会出现「某行重复出现、另一行被跳过」。
  const stableOrderBy = `${orderBy}, id ASC`;
  const limitClause = options.limit ? " LIMIT ? OFFSET ?" : "";
  const queryParameters = options.limit
    ? [...parameters, options.limit, options.offset || 0]
    : parameters;
  return all<UsageEvent>(
    `SELECT ${buildEventSelect(options.alias || "")} FROM ${options.from || "usage_events"} ${options.alias ? options.alias : ""} ${whereClause} ORDER BY ${stableOrderBy}${limitClause}`,
    queryParameters,
  );
}

async function queryUsageEventsForSessions(filters: EventFilters = {}, sessions: SessionRef[] = []): Promise<UsageEvent[]> {
  await initializeDatabase();
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }

  const { conditions, parameters } = buildEventConditions(filters, "u");
  // 用行值 IN (VALUES ...) 而不是 N 个 (session_id = ? AND project_name = ?) 的 OR 串。
  // OR 串会让 SQLite 的表达式树深度随会话数线性增长，1000 个会话即报
  // "Expression tree is too large" —— 导出接口按 5000 会话封顶，必然踩中。
  // 行值写法是平铺的参数列表，只受 SQLITE_MAX_VARIABLE_NUMBER（默认 32766）约束，
  // 因此再按参数预算分批，保证任意会话数都不会触发上限。
  const maxPairsPerBatch = Math.max(1, Math.floor((MAX_SQL_VARIABLES - parameters.length) / 2));
  const results: UsageEvent[] = [];
  for (let start = 0; start < sessions.length; start += maxPairsPerBatch) {
    const batch = sessions.slice(start, start + maxPairsPerBatch);
    const placeholders = batch.map(() => "(?, ?)").join(", ");
    const batchParameters = [...parameters];
    for (const session of batch) {
      batchParameters.push(session.sessionId, session.projectName);
    }
    const rows = await all<UsageEvent>(
      `
        SELECT ${buildEventSelect("u")}
        FROM usage_events u
        WHERE ${conditions.concat([`(u.session_id, u.project_name) IN (VALUES ${placeholders})`]).join(" AND ")}
        ORDER BY u.timestamp DESC
      `,
      batchParameters,
    );
    results.push(...rows);
  }
  // 分批查询后需在内存里恢复整体的排序语义。
  return results.sort((left, right) => String(right.timestamp || "").localeCompare(String(left.timestamp || "")));
}

interface CountRow { count: number }

async function countUsageEvents(filters: EventFilters = {}): Promise<number> {
  await initializeDatabase();
  const { conditions, parameters } = buildEventConditions(filters);
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = await get<CountRow>(`SELECT COUNT(*) AS count FROM usage_events ${whereClause}`, parameters);
  return Number(row.count);
}

async function querySessions(filters: EventFilters = {}, options: QueryOptions = {}): Promise<SessionRow[]> {
  await initializeDatabase();
  const { conditions, parameters } = buildEventConditions(filters, "u");
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // 同上：并列时用分组键兜底，保证翻页不重不漏。
  const sortClause = `${options.orderBy || "timestamp DESC"}, u.session_id ASC, u.project_name ASC, u.platform ASC`;
  const limitClause = options.limit ? " LIMIT ? OFFSET ?" : "";
  const queryParameters = options.limit
    ? [...parameters, options.limit, options.offset || 0]
    : parameters;
  return all<SessionRow>(
    `
      SELECT
        u.session_id AS sessionId,
        u.project_name AS projectName,
        MIN(u.timestamp) AS firstTimestamp,
        MAX(u.timestamp) AS timestamp,
        MAX(u.timestamp) AS lastTimestamp,
        CASE
          WHEN COUNT(DISTINCT CASE WHEN u.model IS NOT NULL AND u.model NOT IN ('unknown', '<synthetic>', '') THEN u.model END) > 1 THEN 'multiple'
          WHEN COUNT(DISTINCT CASE WHEN u.model IS NOT NULL AND u.model NOT IN ('unknown', '<synthetic>', '') THEN u.model END) = 1 THEN MIN(CASE WHEN u.model IS NOT NULL AND u.model NOT IN ('unknown', '<synthetic>', '') THEN u.model END)
          ELSE '--'
        END AS model,
        MIN(u.platform) AS platform,
        SUM(u.total_tokens) AS totalTokens,
        SUM(u.input_tokens) AS inputTokens,
        SUM(u.output_tokens) AS outputTokens,
        SUM(u.cache_read_tokens) AS cacheReadTokens,
        SUM(u.cache_creation_tokens) AS cacheCreationTokens
      FROM usage_events u
      ${whereClause}
      -- 必须把 platform 也放进 GROUP BY：platform 过滤条件只作用在 WHERE 上，
      -- 若分组忽略它，跨平台重名的 (session_id, project_name) 会被合成一行、
      -- 汇总两个平台的 token，却只顶着 MIN(platform) 一个标签。
      GROUP BY u.session_id, u.project_name, u.platform
      ORDER BY ${sortClause}${limitClause}
    `,
    queryParameters,
  );
}

async function countSessions(filters: EventFilters = {}): Promise<number> {
  await initializeDatabase();
  const { conditions, parameters } = buildEventConditions(filters, "u");
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = await get<CountRow>(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM usage_events u ${whereClause} GROUP BY u.session_id, u.project_name, u.platform)`, parameters);
  return Number(row.count);
}

// 返回每个会话内各真实模型的 token 用量明细，按用量从高到低，供列表「模型」列展示（替代 multiple）。
async function getSessionModelBreakdown(sessionIds: Array<string | { sessionId: string; projectName: string | null }>): Promise<Record<string, Array<{ model: string; tokens: number }>>> {
  await initializeDatabase();
  if (!sessionIds || !sessionIds.length) return {};
  const keys = sessionIds.map((item) => typeof item === "string"
    ? { sessionId: item, projectName: null }
    : item).filter((item) => item && item.sessionId);
  if (!keys.length) return {};
  const conditions = keys.map((item) => item.projectName
    ? "(session_id = ? AND project_name = ?)"
    : "session_id = ?");
  const parameters: unknown[] = [];
  for (const item of keys) {
    parameters.push(item.sessionId);
    if (item.projectName) parameters.push(item.projectName);
  }
  const rows = await all<{ sessionId: string; projectName: string; model: string; tokens: number }>(
    `SELECT session_id AS sessionId, project_name AS projectName, model, SUM(total_tokens) AS tokens
     FROM usage_events
     WHERE (${conditions.join(" OR ")}) AND model IS NOT NULL AND model != '' AND model NOT IN ('unknown', '<synthetic>')
     GROUP BY session_id, project_name, model`,
    parameters,
  );
  const map: Record<string, Array<{ model: string; tokens: number }>> = {};
  for (const r of rows) {
    const id = r.projectName ? `${r.projectName}\0${r.sessionId}` : r.sessionId;
    (map[id] || (map[id] = [])).push({ model: r.model, tokens: Number(r.tokens) || 0 });
  }
  for (const id of Object.keys(map)) map[id].sort((a, b) => b.tokens - a.tokens);
  return map;
}

async function getSessionEvents(sessionId: string, projectName: string): Promise<UsageEvent[]> {
  return getSessionEventPage(sessionId, projectName);
}

async function getSessionEventPage(
  sessionId: string,
  projectName: string,
  options: QueryOptions & { platform?: string } = {},
): Promise<UsageEvent[]> {
  await initializeDatabase();
  // platform 可选：session_id 跨平台并不唯一，调用方（会话详情接口）必须传，
  // 否则会把别的平台同名会话的事件一并返回。
  const filters = options.platform
    ? { sessionId, projectName, platform: options.platform }
    : { sessionId, projectName };
  return queryUsageEvents(filters, {
    orderBy: options.orderBy || "timestamp ASC",
    limit: options.limit,
    offset: options.offset || 0,
  });
}

async function countSessionEvents(sessionId: string, projectName: string, platform?: string): Promise<number> {
  return countUsageEvents(platform ? { sessionId, projectName, platform } : { sessionId, projectName });
}

async function getSessionModelUsage(
  sessionId: string,
  projectName: string,
  platform?: string,
): Promise<Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number }>> {
  await initializeDatabase();
  const conditions = ["session_id = ?", "project_name = ?"];
  const parameters: unknown[] = [sessionId, projectName];
  if (platform) {
    conditions.push("platform = ?");
    parameters.push(platform);
  }
  return all<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number }>(
    `
      SELECT
        COALESCE(model, 'unknown') AS model,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(cache_creation_tokens) AS cacheCreationTokens,
        SUM(total_tokens) AS totalTokens
      FROM usage_events
      WHERE ${conditions.join(" AND ")}
      -- 与 SELECT 的 COALESCE 保持一致：否则 NULL 与字面量 'unknown' 会分成两组、
      -- 返回两条同名记录，按模型聚合时键冲突。
      GROUP BY COALESCE(model, 'unknown')
    `,
    parameters,
  );
}

async function getSessionSourceFiles(sessionId: string, projectName: string): Promise<string[]> {
  await initializeDatabase();
  const rows = await all<{ sourceFile: string }>(
    "SELECT DISTINCT source_file AS sourceFile FROM usage_events WHERE session_id = ? AND project_name = ?",
    [sessionId, projectName],
  );
  return rows.map((row) => row.sourceFile).filter(Boolean);
}

async function getFilterOptions(): Promise<FilterOptions> {
  await initializeDatabase();
  const [projects, models, platforms] = await Promise.all([
    all<{ value: string }>("SELECT DISTINCT project_name AS value FROM usage_events ORDER BY project_name"),
    all<{ value: string }>("SELECT DISTINCT COALESCE(model, 'unknown') AS value FROM usage_events ORDER BY value"),
    all<{ value: string }>("SELECT DISTINCT platform AS value FROM usage_events ORDER BY platform"),
  ]);
  return {
    projects: projects.map((item) => item.value),
    models: models.map((item) => item.value),
    platforms: platforms.map((item) => item.value),
  };
}

/**
 * 读取全部同步状态。
 *
 * 返回的 Map 以 `platform\0file_path` 为键 —— 不同平台的相对路径会完全相同
 * （见 migrateImportedLogsPrimaryKey 的说明），只用 file_path 会互相覆盖。
 * 取值请用 `importedLogKey(platform, filePath)`。
 */
async function getImportedLogFiles(): Promise<Map<string, ImportedLogState>> {
  await initializeDatabase();
  const rows = await all<{
    file_path: string;
    modified_time_ms: number;
    file_size: number;
    byte_offset: number;
    last_sync_at: string | null;
    status: string;
    error: string | null;
    platform: string;
  }>(`
    SELECT file_path, modified_time_ms, file_size, byte_offset,
           last_sync_at, status, error, platform
    FROM imported_logs
  `);
  return new Map(rows.map((row) => [importedLogKey(row.platform || "claude", row.file_path), {
    modifiedTimeMs: Number(row.modified_time_ms),
    fileSize: Number(row.file_size),
    byteOffset: Number(row.byte_offset),
    lastSyncAt: row.last_sync_at,
    status: row.status,
    error: row.error,
    platform: row.platform || "claude",
  }]));
}

async function markLogFileImported(filePath: string, state: Partial<ImportedLogState>): Promise<void> {
  await initializeDatabase();
  const platform = state.platform || "claude";
  await run(
    `
      INSERT INTO imported_logs (
        file_path, modified_time_ms, file_size, byte_offset,
        last_sync_at, status, error, platform
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, platform) DO UPDATE SET
        modified_time_ms = excluded.modified_time_ms,
        file_size = excluded.file_size,
        byte_offset = excluded.byte_offset,
        last_sync_at = excluded.last_sync_at,
        status = excluded.status,
        error = excluded.error
    `,
    [
      filePath,
      Number(state.modifiedTimeMs) || 0,
      Number(state.fileSize) || 0,
      Number(state.byteOffset) || 0,
      state.lastSyncAt || new Date().toISOString(),
      state.status || "ready",
      state.error || null,
      platform,
    ],
  );
}

/**
 * 删除某个源文件此前导入的事件。
 *
 * 必须同时限定 platform：file_path 是相对各平台根目录的路径，跨平台会重名，
 * 只按 source_file 删除会连带清掉别的平台的用量（且同步仍报成功）。
 */
async function deleteUsageEventsForFile(filePath: string, platform?: string): Promise<void> {
  await initializeDatabase();
  const conditions = ["source_file = ?"];
  const parameters: unknown[] = [filePath];
  if (platform) {
    conditions.push("platform = ?");
    parameters.push(platform);
  }
  const whereClause = conditions.join(" AND ");

  // 先算涉及哪些会话，删除后据实重算它们的聚合值。
  const sessions = await all<{ sessionId: string; projectName: string }>(
    `SELECT DISTINCT session_id AS sessionId, project_name AS projectName FROM usage_events WHERE ${whereClause}`,
    parameters,
  );
  // 与删除、重算合为一个事务，避免并发同步的另一平台事务回滚时把这次删除一并撤销。
  await withTransaction(async () => {
    await run(`DELETE FROM usage_events WHERE ${whereClause}`, parameters);
    for (const session of sessions) {
      await refreshSessionTotals(session.sessionId, session.projectName);
    }
  });
}

async function getUsageEventCount(platform?: string): Promise<number> {
  await initializeDatabase();
  const row = platform
    ? await get<CountRow>("SELECT COUNT(*) AS count FROM usage_events WHERE platform = ?", [platform])
    : await get<CountRow>("SELECT COUNT(*) AS count FROM usage_events");
  return Number(row.count);
}

async function getImportDiagnostics(platform?: string): Promise<ImportDiagnostic[]> {
  await initializeDatabase();
  const conditions = ["status = 'error'"];
  const parameters: unknown[] = [];
  if (platform) {
    conditions.push("platform = ?");
    parameters.push(platform);
  }
  return all<ImportDiagnostic>(
    `
      SELECT file_path AS filePath, status, error, last_sync_at AS lastSyncAt,
             byte_offset AS byteOffset, file_size AS fileSize, platform
      FROM imported_logs
      WHERE ${conditions.join(" AND ")}
      ORDER BY last_sync_at DESC
    `,
    parameters,
  );
}

async function closeDatabase(): Promise<void> {
  if (!database) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    database!.close((error: Error | null) => error ? reject(error) : resolve());
  });
  database = null;
  initializationPromise = null;
}

// 启动期一次性迁移：把早期版本写入的绝对路径（含用户主目录，如
// C:\Users\ZT\.claude\projects\...）改写为相对 ~/.claude/projects/ 的路径，
// 避免本地数据库泄露 OS 用户名与绝对目录结构。幂等：仅处理 path.isAbsolute 为真的旧行。
async function migrateSourcePathsToRelative(baseDir: string): Promise<void> {
  await initializeDatabase();
  const resolvedBaseDir = path.resolve(baseDir);
  // 只改写「确实位于该根目录下」的绝对路径。
  // 否则一旦库里混有别的平台的绝对路径，path.relative 会把它改写成 ../../… 这类更糟的值。
  const normalize = (value: unknown): unknown => {
    if (!value || typeof value !== "string" || !path.isAbsolute(value)) return value;
    try {
      const relative = path.relative(resolvedBaseDir, value);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return value;
      return relative.split(path.sep).join("/");
    } catch {
      return value;
    }
  };

  const getTimestamp = (value: unknown): number => {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
  };

  interface ImportedLogRow {
    file_path: string;
    modified_time_ms: number;
    file_size: number;
    byte_offset: number;
    last_sync_at: string | null;
    status: string;
    error: string | null;
    platform: string;
  }

  const chooseImportedLogState = (rows: Array<ImportedLogRow & { relativePath: string }>): ImportedLogRow & { relativePath: string } => rows.slice().sort((left, right) => {
    const offsetDifference = Number(right.byte_offset) - Number(left.byte_offset);
    if (offsetDifference !== 0) return offsetDifference;
    const sizeDifference = Number(right.file_size) - Number(left.file_size);
    if (sizeDifference !== 0) return sizeDifference;
    const timestampDifference = getTimestamp(right.last_sync_at) - getTimestamp(left.last_sync_at);
    if (timestampDifference !== 0) return timestampDifference;
    return (right.status === "ready" ? 1 : 0) - (left.status === "ready" ? 1 : 0);
  })[0];

  await withTransaction(async () => {
    const logs = await all<ImportedLogRow>(`
      SELECT file_path, modified_time_ms, file_size, byte_offset,
             last_sync_at, status, error, platform
      FROM imported_logs
    `);
    const groupedLogs = new Map<string, Array<ImportedLogRow & { relativePath: string }>>();
    for (const row of logs) {
      const relativePath = normalize(row.file_path) as string;
      // 按 (platform, 相对路径) 分组：不同平台的相对路径会完全相同，
      // 只按路径分组会把两个平台的状态合并成一行、互相覆盖。
      const groupKey = importedLogKey(row.platform || "claude", relativePath);
      const group = groupedLogs.get(groupKey) || [];
      group.push({ ...row, relativePath });
      groupedLogs.set(groupKey, group);
    }

    for (const [, rows] of groupedLogs) {
      const preferred = chooseImportedLogState(rows);
      const relativePath = preferred.relativePath;
      if (rows.length > 1 || preferred.file_path !== relativePath) {
        await run("DELETE FROM imported_logs WHERE file_path IN (" + rows.map(() => "?").join(",") + ")", rows.map((row) => row.file_path));
        await run(
          `
            INSERT INTO imported_logs (
              file_path, modified_time_ms, file_size, byte_offset,
              last_sync_at, status, error, platform
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            relativePath,
            Number(preferred.modified_time_ms) || 0,
            Number(preferred.file_size) || 0,
            Number(preferred.byte_offset) || 0,
            preferred.last_sync_at || null,
            preferred.status || "ready",
            preferred.error || null,
            // 必须带上 platform：漏掉它会把迁移过的行静默改标成默认的 'claude'
            preferred.platform || "claude",
          ],
        );
      }
    }

    const events = await all<{ source_file: string }>("SELECT DISTINCT source_file FROM usage_events");
    for (const row of events) {
      if (!row.source_file) continue;
      const relativePath = normalize(row.source_file) as string;
      if (relativePath !== row.source_file) {
        await run("UPDATE usage_events SET source_file = ? WHERE source_file = ?", [relativePath, row.source_file]);
      }
    }
  });
}

export = {
  databasePath,
  initializeDatabase,
  processImportedChunk,
  queryUsageEvents,
  queryUsageEventsForSessions,
  countUsageEvents,
  querySessions,
  countSessions,
  getSessionModelBreakdown,
  getSessionEvents,
  getSessionEventPage,
  countSessionEvents,
  getSessionModelUsage,
  getSessionSourceFiles,
  getPagination,
  getSortClause,
  getFilterOptions,
  getImportedLogFiles,
  importedLogKey,
  markLogFileImported,
  deleteUsageEventsForFile,
  withTransaction,
  getUsageEventCount,
  getImportDiagnostics,
  migrateSourcePathsToRelative,
  closeDatabase,
};
