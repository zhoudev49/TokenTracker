// Express 服务：日志扫描与增量同步、REST API、CSV 导出。
import express, { type Express, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import {
  initializeDatabase,
  processImportedChunk,
  queryUsageEvents,
  queryUsageEventsForSessions,
  querySessions,
  countSessions,
  getSessionModelBreakdown,
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
} from "./database";
import { toTokenCount } from "./log-parser";
import {
  DEFAULT_PRICING,
  calculateUsageCost,
  parseCustomPricing,
} from "./pricing";
import {
  addCostsToProjects,
  calculateCacheAnalytics,
  calculateProjectStats,
  rowsToCsv,
} from "./analytics";
import {
  claudeAdapter,
  defaultResolveSourcePath,
  describeAdapters,
  getAdapter,
  listAdapters,
} from "./platforms";
import type {
  PlatformAdapter,
  PlatformFileInfo,
  PromptSegments,
} from "./platforms";
import type {
  EventFilters,
  ImportedLogState,
  SessionRow,
  UsageEvent,
} from "./types";

// 「编码目录名 -> 真实工作目录」映射，由各平台适配器的 loadProjectRealPaths 汇总。
// Claude Code / CodeBuddy / WorkBuddy 等把 ':' '\' '/' '_' 全部编码成 '-'，
// 纯字符串无法区分真实连字符与分隔符，只能从日志里的 cwd 字段还原。
// 同名项目（同一 cwd 编码）在所有平台下自然合并，跨平台的项目成本中心才能对齐。
let projectRealPaths = new Map<string, string>();

function resolveSourcePath(adapter: PlatformAdapter, storedPath: string): string {
  return defaultResolveSourcePath(adapter.rootDir, storedPath);
}

// 把 Claude Code 的项目目录编码名还原为可读路径。
// 优先使用日志中记录的真实 cwd；无法获取时回退到字符串解码（仍可能误拆连字符）。
function decodeProjectName(encoded: string): string {
  if (!encoded || typeof encoded !== "string") return encoded;
  if (projectRealPaths && projectRealPaths.has(encoded)) return projectRealPaths.get(encoded)!;
  if (!encoded.includes("-")) return encoded;
  return encoded
    .replace(/^([A-Za-z])--/, (_, drive) => `${drive}:\\`)
    .replace(/-/g, "\\");
}

// 给含 projectName 的对象补充 projectDisplayName（原始名仍作筛选 key）。
function withProjectDisplayName<T extends { projectName?: string; projectDisplayName?: string }>(item: T): T {
  if (!item || typeof item !== "object") return item;
  if (item.projectName && item.projectDisplayName === undefined) {
    item.projectDisplayName = decodeProjectName(item.projectName);
  }
  return item;
}

const app: Express = express();
const PORT: number = Number(process.env.PORT) || 3000;
const HOST: string = process.env.HOST || "127.0.0.1";
const LOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_ALERT_THRESHOLD_USD = 10;
// 单次 CSV / JSON 导出的会话数上限（防止全量导出把内存与事件循环拖垮）。
const MAX_EXPORT_SESSIONS = 5000;

interface SyncError { filePath: string; message: string }

interface SyncState {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  scannedFiles: number;
  updatedFiles: number;
  importedEvents: number;
  duplicateRecords: number;
  invalidLines: number;
  failedFiles: number;
  errors: SyncError[];
}

// 启动后的首次全平台同步只跑一次。
// 必须用一个「跑完仍保持为真」的布尔量来闩住，而不是靠把 promise 置回 null：
// 后者会让每个 API 请求都重新触发一次 8 平台全量同步（前端默认 30s 轮询），
// 而且一旦首次同步失败，被缓存的 rejected promise 会让后续所有请求都拿到同一个错误。
let initialSyncStarted = false;
let initialSyncPromise: Promise<void> | null = null;
let syncTimer: NodeJS.Timeout | null = null;

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "..", "public"), {
  maxAge: 0,
  setHeaders(res: Response, filePath: string) {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 取出字符串查询参数。
 *
 * Express 5 默认的 "simple" query parser 在参数重复时（`?platform=a&platform=b`）
 * 会把值解析成**数组**，此时若静默返回 undefined，过滤条件就被整个丢掉 ——
 * 这是「过滤失效但结果照常返回」的 fail-open，比直接报错更危险。
 * 这里改为取第一个值并保持过滤生效；同时 trim，避免 `?platform=%20` 这类空白值穿透。
 */
function queryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    // 重复参数：取第一个非空值（Express 的另一种形态是 { key: [...] } 对象）
    for (const item of value) {
      const candidate = queryStringValue(item);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function getSessionFilters(query: Request["query"]): EventFilters {
  return {
    date: queryStringValue(query.date),
    startDate: queryStringValue(query.startDate),
    endDate: queryStringValue(query.endDate),
    model: queryStringValue(query.model),
    projectName: queryStringValue(query.projectName),
    search: query.search ? String(query.search).slice(0, 200) : undefined,
    platform: queryStringValue(query.platform),
  };
}

/** 单条日志文件的导入信息（与适配器的 PlatformFileInfo 同形）。 */
export type ClaudeLogFileInfo = PlatformFileInfo;

async function listClaudeLogFiles(): Promise<ClaudeLogFileInfo[]> {
  return claudeAdapter.listFiles();
}

/**
 * 逐行读取 [startOffset, fileSize) 区间内**以换行结束**的完整行。
 *
 * 返回值里的 `nextOffset` 只推进到最后一个换行之后，因此末尾未终结的半行会留在
 * 区间之外、下次同步重读；`trailingFragment` 把这段残留原文一并交出，
 * 供调用方判断它是否已经是一条完整记录（见 importPlatformFile 的处理）。
 */
async function readCompleteLines(
  filePath: string,
  startOffset: number,
  fileSize: number,
  onLine: (line: string, lineOffset: number) => void,
): Promise<{ nextOffset: number; trailingFragment: string | null }> {
  if (fileSize <= startOffset) {
    return { nextOffset: startOffset, trailingFragment: null };
  }

  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const pendingLineParts: Buffer[] = [];
    let pendingLineLength = 0;
    let position = startOffset;
    let nextOffset = startOffset;
    // 当前累积中的这一行在文件里的起始字节偏移：跨同步稳定，可作为兜底事件 id。
    let pendingLineStart = startOffset;

    while (position < fileSize) {
      const length = Math.min(buffer.length, fileSize - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] !== 10) continue;

        const segment = chunk.subarray(segmentStart, index);
        if (segment.length > 0) {
          pendingLineParts.push(Buffer.from(segment));
          pendingLineLength += segment.length;
        }
        const line = pendingLineLength === 0
          ? ""
          : pendingLineParts.length === 1
            ? pendingLineParts[0].toString("utf8")
            : Buffer.concat(pendingLineParts, pendingLineLength).toString("utf8");
        onLine(line, pendingLineStart);
        pendingLineParts.length = 0;
        pendingLineLength = 0;
        segmentStart = index + 1;
        nextOffset = position + index + 1;
        pendingLineStart = nextOffset;
      }

      if (segmentStart < bytesRead) {
        const segment = chunk.subarray(segmentStart);
        pendingLineParts.push(Buffer.from(segment));
        pendingLineLength += segment.length;
      }
      position += bytesRead;
    }

    const trailingFragment = pendingLineLength === 0
      ? null
      : (pendingLineParts.length === 1
        ? pendingLineParts[0].toString("utf8")
        : Buffer.concat(pendingLineParts, pendingLineLength).toString("utf8"));

    return { nextOffset, trailingFragment };
  } finally {
    await handle.close();
  }
}

async function readCompleteChunk(filePath: string, startOffset: number, fileSize: number): Promise<{ content: string; nextOffset: number }> {
  const lines: string[] = [];
  const { nextOffset } = await readCompleteLines(filePath, startOffset, fileSize, (line) => {
    lines.push(line);
  });
  return {
    content: lines.length ? `${lines.join("\n")}\n` : "",
    nextOffset,
  };
}

/**
 * 导入单个源文件。两种模式共用同一套状态机：
 *  - incremental：从上次记录的字节偏移继续追加解析（Claude 形态日志天然可续）；
 *  - rebuild：整份重新解析后替换该文件此前写入的事件（累计差分 / 单库聚合无法续读）。
 */
async function importPlatformFile(
  adapter: PlatformAdapter,
  file: PlatformFileInfo,
  previousState: ImportedLogState | null | undefined,
  options: { forceRebuild?: boolean } = {},
): Promise<{ importedEvents: number; duplicateRecords: number; invalidLines: number }> {
  const storedPath = file.storedPath || file.filePath;
  const incremental = adapter.mode === "incremental" && typeof adapter.createIncrementalParser === "function";
  // 本函数会直接开事务写库，必须先确保连接就绪：
  // withTransaction 走的是 run()，在 initializeDatabase 之前调用会拿到空连接。
  await initializeDatabase();

  if (!incremental) {
    const parsed = await adapter.parseFile(file);
    if (!parsed) {
      throw new Error(`Unable to read ${adapter.label} source file: ${storedPath}`);
    }
    // 解析结果为空时绝不能先删后插：源库表缺失/损坏/被锁时读取器会「成功返回空数组」，
    // 删除会清掉此前导入的全部事件，而文件随即被标记 ready，再也不重试 —— 历史数据被不可逆销毁。
    // 用 previousState 判定「这个文件此前确实导入过」：只有确实导入过才允许空结果落地。
    const previouslyImported = Boolean(
      previousState &&
      previousState.status !== "error" &&
      (previousState.byteOffset > 0 || previousState.fileSize > 0),
    );
    if (parsed.events.length === 0 && previouslyImported) {
      throw new Error(
        `${adapter.label} source file yielded no events but was previously imported; ` +
        `refusing to drop existing rows for ${storedPath} (the source may be unreadable or reset).`,
      );
    }
    // 整份重建：先清掉该文件此前写入的事件，避免编号变化后留下孤儿行。
    // 删除 + 写入 + 标记状态合为一个事务，否则并发同步的另一个平台事务回滚时
    // 会把这里的删除一并撤销，留下永远清不掉的孤儿行（重复计数）。
    await withTransaction(async () => {
      await deleteUsageEventsForFile(storedPath, adapter.id);
      await processImportedChunk(parsed.session, parsed.events);
      await markLogFileImported(storedPath, {
        modifiedTimeMs: file.modifiedTimeMs,
        fileSize: file.fileSize,
        byteOffset: file.fileSize,
        status: "ready",
        platform: adapter.id,
      });
    });
    return {
      importedEvents: parsed.events.length,
      duplicateRecords: parsed.duplicateRecords,
      invalidLines: parsed.invalidLines,
    };
  }

  const previous = options.forceRebuild ? null : previousState;
  let startOffset = previous ? previous.byteOffset : 0;
  const requiresRebuild =
    !previous ||
    file.fileSize < previous.byteOffset ||
    // 大小不变但 mtime 变了 —— 内容被原地改写，追加式续读会漏掉改动。
    (file.fileSize === previous.fileSize && file.modifiedTimeMs !== previous.modifiedTimeMs);

  if (requiresRebuild) {
    startOffset = 0;
  }

  const parser = adapter.createIncrementalParser!(file);
  const read = await readCompleteLines(
    file.filePath,
    startOffset,
    file.fileSize,
    (line, lineOffset) => parser.addLine(line, lineOffset),
  );

  // 文件末尾最后一行可能没有换行符（进程在写完最后一条记录前退出、日志被截断等）。
  // 只按 '\n' 推进偏移会把这条完整记录永久丢弃，而且文件每次同步都会被重新解析。
  // 若该残留片段本身是合法 JSON，说明它是完整记录，应当就地消费；否则保留偏移，
  // 等下次同步它补全后再读 —— 半个 JSON 对象不能被当成一条记录。
  let nextOffset = read.nextOffset;
  if (read.trailingFragment) {
    let complete = false;
    try {
      JSON.parse(read.trailingFragment);
      complete = true;
    } catch {
      complete = false;
    }
    if (complete) {
      parser.addLine(read.trailingFragment, read.nextOffset);
      nextOffset = file.fileSize;
    }
  }
  const parsed = parser.finish();
  // 删除 + 写入 + 标记状态合为一个事务：否则并发同步的另一个平台事务回滚时
  // 会把这里的删除一并撤销，留下永远清不掉的孤儿行（重复计数）。
  await withTransaction(async () => {
    if (requiresRebuild) {
      await deleteUsageEventsForFile(storedPath, adapter.id);
    }
    await processImportedChunk(parsed.session, parsed.events);
    await markLogFileImported(storedPath, {
      modifiedTimeMs: file.modifiedTimeMs,
      fileSize: file.fileSize,
      byteOffset: nextOffset,
      status: "ready",
      platform: adapter.id,
    });
  });

  return {
    importedEvents: parsed.events.length,
    duplicateRecords: parsed.duplicateRecords,
    invalidLines: parsed.invalidLines,
  };
}

/** Claude Code 的导入入口（保留原签名，测试与既有调用方依赖它）。 */
async function importLogFile(
  logFile: ClaudeLogFileInfo,
  previousState: ImportedLogState | null | undefined,
): Promise<{ importedEvents: number; duplicateRecords: number; invalidLines: number }> {
  return importPlatformFile(claudeAdapter, logFile, previousState);
}

// ---- 通用同步：所有平台共用一套流程，平台差异全部收敛在适配器里 ----

const syncStates = new Map<string, SyncState>();
const syncPromises = new Map<string, Promise<SyncState>>();

function emptySyncState(): SyncState {
  return {
    running: false,
    startedAt: null,
    completedAt: null,
    scannedFiles: 0,
    updatedFiles: 0,
    importedEvents: 0,
    duplicateRecords: 0,
    invalidLines: 0,
    failedFiles: 0,
    errors: [],
  };
}

function getSyncState(platformId: string): SyncState {
  let state = syncStates.get(platformId);
  if (!state) {
    state = emptySyncState();
    syncStates.set(platformId, state);
  }
  return state;
}

async function syncPlatform(platformId: string): Promise<SyncState> {
  const running = syncPromises.get(platformId);
  if (running) {
    return running;
  }

  const adapter = getAdapter(platformId);
  if (!adapter) {
    throw new Error(`Unknown platform: ${platformId}`);
  }

  const promise = (async () => {
    const state: SyncState = { ...emptySyncState(), running: true, startedAt: new Date().toISOString() };
    syncStates.set(platformId, state);

    try {
      await initializeDatabase();
      if (platformId === "claude") {
        // 早期版本写入过含用户主目录的绝对路径，这里幂等改写为相对路径。
        await migrateSourcePathsToRelative(adapter.rootDir);
      }

      const [files, importedLogFiles, existingEventCount] = await Promise.all([
        adapter.listFiles(),
        getImportedLogFiles(),
        getUsageEventCount(platformId),
      ]);
      state.scannedFiles = files.length;
      const forceInitialRebuild = existingEventCount === 0;

      for (const file of files) {
        // imported_logs 以 (platform, 相对路径) 为键：不同平台的相对路径会同名，
        // 只按路径查会把上一个平台的同步状态错当成这个平台的。
        const previousState =
          importedLogFiles.get(importedLogKey(adapter.id, file.storedPath)) ||
          importedLogFiles.get(importedLogKey(adapter.id, file.filePath));
        const unchanged =
          !forceInitialRebuild &&
          previousState &&
          previousState.status !== "error" &&
          previousState.modifiedTimeMs === file.modifiedTimeMs &&
          previousState.fileSize === file.fileSize &&
          // 增量平台还要求上次已读到文件末尾；重建平台整份解析，无从比对偏移。
          (adapter.mode !== "incremental" || previousState.byteOffset === file.fileSize);

        if (unchanged) {
          continue;
        }

        try {
          const result = await importPlatformFile(adapter, file, previousState, {
            forceRebuild: forceInitialRebuild,
          });
          state.updatedFiles += 1;
          state.importedEvents += result.importedEvents;
          state.duplicateRecords += result.duplicateRecords;
          state.invalidLines += result.invalidLines;
        } catch (error) {
          state.failedFiles += 1;
          const message = error instanceof Error ? error.message : String(error);
          state.errors.push({ filePath: file.storedPath, message });
          await markLogFileImported(file.storedPath, {
            modifiedTimeMs: file.modifiedTimeMs,
            fileSize: file.fileSize,
            byteOffset: previousState ? previousState.byteOffset : 0,
            status: "error",
            error: message,
            platform: adapter.id,
          }).catch(() => {});
          console.error(`Failed to import ${adapter.label} file ${file.filePath}:`, error);
        }
      }

      // 同步完成后刷新该平台的「编码项目名 -> 真实 cwd」映射：
      // 新出现的项目也能显示可读路径，而不必重启服务。
      if (state.updatedFiles > 0) {
        await mergeProjectRealPaths(projectRealPaths, adapter);
      }
    } finally {
      state.running = false;
      state.completedAt = new Date().toISOString();
    }
    return { ...state };
  })().finally(() => {
    syncPromises.delete(platformId);
  });

  syncPromises.set(platformId, promise);
  return promise;
}

async function syncClaudeLogs(): Promise<SyncState> {
  return syncPlatform("claude");
}

async function syncCodexLogs(): Promise<SyncState> {
  return syncPlatform("codex");
}

async function syncAllPlatforms(): Promise<void> {
  await Promise.all(listAdapters().map((adapter) =>
    syncPlatform(adapter.id).catch((error) => {
      console.error(`Sync failed for ${adapter.label}:`, error);
    }),
  ));
}

async function ensureInitialSync(): Promise<void> {
  // 已经跑过（无论成功与否）就不再重跑；同步本身已有 syncAllPlatforms 的去重，
  // 这里的闩只负责「首次触发」这一次。
  if (initialSyncStarted) {
    return initialSyncPromise || Promise.resolve();
  }
  initialSyncStarted = true;
  initialSyncPromise = syncAllPlatforms()
    .catch((error) => {
      // 首次同步失败不应让每个后续请求都失败：记录并放行，
      // 之后由定时同步或手动 /api/sync 重试。
      console.error("Initial sync failed:", error);
    })
    .finally(() => {
      initialSyncPromise = null;
    });
  return initialSyncPromise;
}

interface DailyTrendPoint { date: string; totalTokens: number }
interface ModelDistributionPoint { model: string; totalTokens: number; percentage: number }

interface TokenPartition {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function aggregateEvents(events: UsageEvent[], endDate?: string): TokenPartition & { dailyTrend: DailyTrendPoint[]; modelDistribution: ModelDistributionPoint[] } {
  const dailyTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();
  const partition: TokenPartition = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const event of events) {
    const totalTokens = toTokenCount(event.totalTokens);
    partition.totalTokens += totalTokens;
    partition.inputTokens += toTokenCount(event.inputTokens);
    partition.outputTokens += toTokenCount(event.outputTokens);
    partition.cacheReadTokens += toTokenCount(event.cacheReadTokens);
    partition.cacheCreationTokens += toTokenCount(event.cacheCreationTokens);
    if (event.timestamp) {
      const timestamp = new Date(event.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        const date = getLocalDateKey(timestamp);
        dailyTotals.set(date, (dailyTotals.get(date) || 0) + totalTokens);
      }
    }
    const model = event.model;
    if (model && model !== "unknown" && model !== "<synthetic>" && model !== "") {
      modelTotals.set(model, (modelTotals.get(model) || 0) + totalTokens);
    }
  }

  const rangeEnd = endDate ? new Date(`${endDate}T12:00:00`) : new Date();
  const safeRangeEnd = Number.isNaN(rangeEnd.getTime()) ? new Date() : rangeEnd;
  const dailyTrend: DailyTrendPoint[] = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(safeRangeEnd);
    date.setDate(date.getDate() - offset);
    const dateKey = getLocalDateKey(date);
    dailyTrend.push({ date: dateKey, totalTokens: dailyTotals.get(dateKey) || 0 });
  }

  const totalTokens = partition.totalTokens;
  const modelDistribution = Array.from(modelTotals, ([model, modelTokens]) => ({
    model,
    totalTokens: modelTokens,
    percentage: totalTokens === 0 ? 0 : Number(((modelTokens / totalTokens) * 100).toFixed(2)),
  })).sort((left, right) => right.totalTokens - left.totalTokens);

  return { ...partition, dailyTrend, modelDistribution };
}

interface CostedSession extends SessionRow {
  estimatedCostUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
  complete: boolean;
  modelBreakdown?: Array<{ model: string; tokens: number }>;
}

function attachSessionCosts(sessions: SessionRow[], events: UsageEvent[], customPricing: unknown): CostedSession[] {
  const eventsBySession = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = `${event.projectName}\0${event.sessionId}`;
    if (!eventsBySession.has(key)) {
      eventsBySession.set(key, []);
    }
    eventsBySession.get(key)!.push(event);
  }

  return sessions.map((session) => {
    const cost = calculateUsageCost(
      eventsBySession.get(`${session.projectName}\0${session.sessionId}`) || [],
      customPricing,
    );
    return { ...session, ...cost };
  });
}

app.get("/api/sessions", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const filters = getSessionFilters(req.query);
    const customPricing = parseCustomPricing(queryStringValue(req.query.pricing));
    const pagination = getPagination(req.query as Record<string, unknown>);
    const orderBy = getSortClause(
      queryStringValue(req.query.sort) || "",
      queryStringValue(req.query.direction) || "",
      {
        timestamp: "timestamp",
        totalTokens: "totalTokens",
        inputTokens: "inputTokens",
        outputTokens: "outputTokens",
        cacheReadTokens: "cacheReadTokens",
        cacheCreationTokens: "cacheCreationTokens",
        projectName: "projectName",
        model: "model",
      },
      "timestamp",
    );
    const [pageSessions, total] = await Promise.all([
      querySessions(filters, { limit: pagination.pageSize, offset: pagination.offset, orderBy }),
      countSessions(filters),
    ]);
    const pageEvents = await queryUsageEventsForSessions(filters, pageSessions);
    const items = attachSessionCosts(pageSessions, pageEvents, customPricing).map(withProjectDisplayName);
    const breakdown = await getSessionModelBreakdown(items.map((s) => ({
      sessionId: s.sessionId,
      projectName: s.projectName,
    })));
    for (const item of items) {
      item.modelBreakdown = breakdown[`${item.projectName}\0${item.sessionId}`] || [];
    }
    res.json({
      items,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
    });
  } catch (error) {
    console.error("Failed to load sessions:", error);
    res.status(500).json({ error: "Failed to load sessions." });
  }
});

// 按 message.id 配对出每条事件的 user / assistant 原文分段。
// 各平台由自己的适配器负责回读：Claude 形态的日志逐行取「最近一条 user 消息」，
// Codex 按轮次号还原，SQLite 型平台不提供正文（返回空表）。
async function loadSessionPrompts(sessionId: string, projectName: string, platform: string): Promise<Map<string, PromptSegments>> {
  const adapter = getAdapter(platform) || claudeAdapter;
  if (!adapter.loadPrompts) {
    return new Map();
  }
  const files = await getSessionSourceFiles(sessionId, projectName);
  return adapter.loadPrompts(sessionId, projectName, files);
}

app.get("/api/sessions/:sessionId", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const projectName = String(req.query.projectName || "");
    if (!projectName) {
      res.status(400).json({ error: "projectName is required." });
      return;
    }
    const sessionId = String(req.params.sessionId);
    // platform 必须传进这几个查询：session_id 在不同平台之间并不唯一
    // （Claude、Codex 各自生成自己的 id），只按 (sessionId, projectName) 查询会把
    // 两个平台的用量混在一起，却顶着其中一个平台的标签返回。
    const platform = queryStringValue(req.query.platform) || "";
    const sessionScope = platform ? { sessionId, projectName, platform } : { sessionId, projectName };
    const pagination = getPagination(req.query as Record<string, unknown>);
    const eventOrderBy = getSortClause(
      queryStringValue(req.query.sort) || "",
      queryStringValue(req.query.direction) || "asc",
      {
        timestamp: "timestamp",
        model: "model",
        inputTokens: "input_tokens",
        outputTokens: "output_tokens",
        cacheReadTokens: "cache_read_tokens",
        cacheCreationTokens: "cache_creation_tokens",
        totalTokens: "total_tokens",
      },
      "timestamp",
    );
    const [summaryRows, events, eventCount, modelUsage] = await Promise.all([
      querySessions(sessionScope, { limit: 1, offset: 0, orderBy: "timestamp ASC" }),
      getSessionEventPage(sessionId, projectName, {
        limit: pagination.pageSize,
        offset: pagination.offset,
        orderBy: eventOrderBy,
        platform: platform || undefined,
      }),
      countSessionEvents(sessionId, projectName, platform || undefined),
      getSessionModelUsage(sessionId, projectName, platform || undefined),
    ]);
    if (summaryRows.length === 0) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    const summary = summaryRows[0];
    const customPricing = parseCustomPricing(queryStringValue(req.query.pricing));
    const cost = calculateUsageCost(modelUsage, customPricing);
    res.json(withProjectDisplayName({
      sessionId,
      projectName,
      platform: summary.platform || "claude",
      firstTimestamp: summary.firstTimestamp,
      lastTimestamp: summary.lastTimestamp,
      eventCount,
      inputTokens: toTokenCount(summary.inputTokens),
      outputTokens: toTokenCount(summary.outputTokens),
      cacheReadTokens: toTokenCount(summary.cacheReadTokens),
      cacheCreationTokens: toTokenCount(summary.cacheCreationTokens),
      totalTokens: toTokenCount(summary.totalTokens),
      ...cost,
      events: events.map((event) => ({
        ...event,
        ...calculateUsageCost([event], customPricing),
      })),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: eventCount,
      totalPages: Math.max(1, Math.ceil(eventCount / pagination.pageSize)),
    }));
  } catch (error) {
    console.error("Failed to load session details:", error);
    res.status(500).json({ error: "Failed to load session details." });
  }
});

// 会话 prompt 缓存：按 项目+会话+源文件 mtime 缓存解析结果，避免每次点击都重读整份日志。
const sessionPromptCache = new Map<string, { mtime: number; data: Map<string, PromptSegments> }>();

async function getSessionPrompts(sessionId: string, projectName: string, platform: string): Promise<Map<string, PromptSegments>> {
  const adapter = getAdapter(platform) || claudeAdapter;
  const files = await getSessionSourceFiles(sessionId, projectName);
  let maxMtime = 0;
  for (const filePath of files) {
    try {
      const st = await fs.promises.stat(resolveSourcePath(adapter, filePath));
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {
      // 文件已不存在则忽略
    }
  }
  const key = `${projectName}\0${sessionId}\0${platform || "claude"}`;
  const cached = sessionPromptCache.get(key);
  if (cached && maxMtime > 0 && cached.mtime === maxMtime) {
    return cached.data;
  }
  const data = await loadSessionPrompts(sessionId, projectName, platform);
  sessionPromptCache.set(key, { mtime: maxMtime, data });
  return data;
}

// 一次性返回整个会话的全部事件 prompt（前端缓存后按需展开，避免反复解析日志）。
app.get("/api/sessions/:sessionId/prompts", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const projectName = String(req.query.projectName || "");
    if (!projectName) {
      res.status(400).json({ error: "projectName is required." });
      return;
    }
    const platform = queryStringValue(req.query.platform) || "claude";
    const prompts = await getSessionPrompts(String(req.params.sessionId), projectName, platform);
    const out: Record<string, PromptSegments> = {};
    for (const [messageId, value] of prompts) out[messageId] = value;
    res.json(out);
  } catch (error) {
    console.error("Failed to load session prompts:", error);
    res.status(500).json({ error: "Failed to load session prompts." });
  }
});

// 单条事件的 prompt（缓存未命中时的兜底）。
app.get("/api/sessions/:sessionId/event/:messageId/prompt", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const projectName = String(req.query.projectName || "");
    if (!projectName) {
      res.status(400).json({ error: "projectName is required." });
      return;
    }
    const platform = queryStringValue(req.query.platform) || "claude";
    const prompts = await getSessionPrompts(String(req.params.sessionId), projectName, platform);
    const prompt = prompts.get(String(req.params.messageId)) || { userSegments: [], assistantSegments: [] };
    res.json(prompt);
  } catch (error) {
    console.error("Failed to load event prompt:", error);
    res.status(500).json({ error: "Failed to load event prompt." });
  }
});

app.get("/api/summary", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const filters = getSessionFilters(req.query);
    const customPricing = parseCustomPricing(queryStringValue(req.query.pricing));
    const [events, sessions] = await Promise.all([
      queryUsageEvents(filters),
      querySessions(filters),
    ]);
    const aggregate = aggregateEvents(events, filters.endDate);
    const cost = calculateUsageCost(events, customPricing);
    res.json({
      totalTokens: aggregate.totalTokens,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheCreationTokens: aggregate.cacheCreationTokens,
      sessionCount: sessions.length,
      ...cost,
      dailyTrend: aggregate.dailyTrend,
      modelDistribution: aggregate.modelDistribution,
    });
  } catch (error) {
    console.error("Failed to build usage summary:", error);
    res.status(500).json({ error: "Failed to build usage summary." });
  }
});

app.get("/api/alerts", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const requestedThreshold = Number(req.query.threshold);
    const thresholdUsd = Number.isFinite(requestedThreshold) && requestedThreshold >= 0
      ? requestedThreshold
      : DEFAULT_ALERT_THRESHOLD_USD;
    const filters = getSessionFilters(req.query);
    filters.date = getLocalDateKey(new Date());
    delete filters.startDate;
    delete filters.endDate;
    const events = await queryUsageEvents(filters);
    const cost = calculateUsageCost(events, parseCustomPricing(queryStringValue(req.query.pricing)));
    const exceeded = cost.complete && cost.estimatedCostUsd > thresholdUsd;
    res.json({ thresholdUsd, todayCostUsd: cost.estimatedCostUsd, exceeded, ...cost });
  } catch (error) {
    console.error("Failed to calculate cost alerts:", error);
    res.status(500).json({ error: "Failed to calculate cost alerts." });
  }
});

app.get("/api/projects", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const events = await queryUsageEvents(getSessionFilters(req.query));
    const projects = addCostsToProjects(
      calculateProjectStats(events),
      events,
      parseCustomPricing(queryStringValue(req.query.pricing)),
    ).map(withProjectDisplayName);
    res.json({ items: projects, total: projects.length });
  } catch (error) {
    console.error("Failed to build project analytics:", error);
    res.status(500).json({ error: "Failed to build project analytics." });
  }
});

app.get("/api/cache-efficiency", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const events = await queryUsageEvents(getSessionFilters(req.query));
    const analytics = calculateCacheAnalytics(events, parseCustomPricing(queryStringValue(req.query.pricing)));
    if (Array.isArray(analytics.breakdown)) {
      analytics.breakdown = analytics.breakdown.map(withProjectDisplayName);
    }
    res.json(analytics);
  } catch (error) {
    console.error("Failed to calculate cache efficiency:", error);
    res.status(500).json({ error: "Failed to calculate cache efficiency." });
  }
});

app.get("/api/export", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const format = String(req.query.format || "csv").toLowerCase();
    if (!["csv", "json"].includes(format)) {
      res.status(400).json({ error: "format must be csv or json." });
      return;
    }
    const filters = getSessionFilters(req.query);
    const customPricing = parseCustomPricing(queryStringValue(req.query.pricing));
    // 导出必须有上限：全量导出的行数完全由用户的日志规模决定，既可能撑爆内存，
    // 也会长时间阻塞事件循环。这里按会话数封顶，只取这些会话的事件（而不是全量事件），
    // 避免「导出 100 行却把上百万条事件读进内存」。超出时通过响应头告知调用方。
    const [sessionRows, sessionTotal] = await Promise.all([
      querySessions(filters, { orderBy: "timestamp DESC", limit: MAX_EXPORT_SESSIONS, offset: 0 }),
      countSessions(filters),
    ]);
    const events = await queryUsageEventsForSessions(filters, sessionRows);
    const truncated = sessionTotal > sessionRows.length;
    if (truncated) {
      res.setHeader("X-Export-Truncated", "true");
      res.setHeader("X-Export-Total-Sessions", String(sessionTotal));
      res.setHeader("X-Export-Included-Sessions", String(sessionRows.length));
      console.warn(`Export truncated: ${sessionRows.length}/${sessionTotal} sessions (limit ${MAX_EXPORT_SESSIONS}).`);
    }
    const rows = attachSessionCosts(sessionRows, events, customPricing).map((session) => ({
      sessionId: session.sessionId,
      projectName: session.projectName,
      projectDisplayName: decodeProjectName(session.projectName),
      platform: session.platform || "claude",
      timestamp: session.timestamp,
      model: session.model,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheCreationTokens: session.cacheCreationTokens,
      totalTokens: session.totalTokens,
    }));
    const filename = `token-tracker-${getLocalDateKey(new Date())}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    if (format === "json") {
      res.type("application/json").send(JSON.stringify({
        filters,
        exportedAt: new Date().toISOString(),
        totalSessions: sessionTotal,
        truncated,
        rows,
      }, null, 2));
      return;
    }
    const columns = [
      ["sessionId", "Session ID"], ["projectName", "Project"], ["projectDisplayName", "Project Path"], ["platform", "Platform"], ["timestamp", "Timestamp"],
      ["model", "Model"], ["inputTokens", "Input Tokens"], ["outputTokens", "Output Tokens"],
      ["cacheReadTokens", "Cache Read Tokens"], ["cacheCreationTokens", "Cache Creation Tokens"],
      ["totalTokens", "Total Tokens"],
    ].map(([key, label]) => ({ key, label }));
    res.type("text/csv; charset=utf-8").send(rowsToCsv(rows, columns));
  } catch (error) {
    console.error("Failed to export sessions:", error);
    res.status(500).json({ error: "Failed to export sessions." });
  }
});

app.get("/api/filters", async (req: Request, res: Response) => {
  try {
    await ensureInitialSync();
    const options = await getFilterOptions();
    res.json({
      ...options,
      projects: (options.projects || []).map((name) => ({ value: name, label: decodeProjectName(name) })),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

app.get("/api/pricing", (req: Request, res: Response) => {
  res.json(DEFAULT_PRICING);
});

// 已注册平台清单 + 本机可用性探测，前端平台下拉直接消费它。
app.get("/api/platforms", (req: Request, res: Response) => {
  res.json({ items: describeAdapters() });
});

app.get("/api/sync/status", async (req: Request, res: Response) => {
  const descriptors = describeAdapters();
  const failures = await Promise.all(
    descriptors.map((descriptor) => getImportDiagnostics(descriptor.id).catch(() => [])),
  );
  const payload: Record<string, unknown> = {};
  descriptors.forEach((descriptor, index) => {
    payload[descriptor.id] = {
      ...getSyncState(descriptor.id),
      label: descriptor.label,
      available: descriptor.available,
      failures: failures[index],
    };
  });
  res.json(payload);
});

app.post("/api/sync", async (req: Request, res: Response) => {
  // Express 5 的 body-parser 在没有请求体（或 Content-Type 不是 JSON）时把 req.body 留成
  // undefined，因此这里不能直接取属性：那会在 try 之外抛 TypeError，
  // 被默认错误处理器渲染成带绝对安装路径的 HTML 500 堆栈。
  // 文档里的 `curl -X POST /api/sync`（不带 body）正是这种请求。
  const requested = String((req.body && req.body.platform) || "").trim();
  if (requested) {
    if (!getAdapter(requested)) {
      res.status(400).json({ error: `Unknown platform: ${requested}` });
      return;
    }
    try {
      res.json(await syncPlatform(requested));
    } catch (error) {
      console.error(`Manual ${requested} sync failed:`, error);
      res.status(500).json({ error: `Failed to sync ${requested} logs.` });
    }
    return;
  }

  // 未指定平台：全部同步一遍，返回汇总（与前端「立即同步」按钮的文案对齐）。
  try {
    await syncAllPlatforms();
    const summary = listAdapters().reduce((total, adapter) => {
      const state = getSyncState(adapter.id);
      total.scannedFiles += state.scannedFiles;
      total.updatedFiles += state.updatedFiles;
      total.importedEvents += state.importedEvents;
      total.duplicateRecords += state.duplicateRecords;
      total.invalidLines += state.invalidLines;
      total.failedFiles += state.failedFiles;
      return total;
    }, emptySyncState());
    res.json(summary);
  } catch (error) {
    console.error("Manual sync failed:", error);
    res.status(500).json({ error: "Failed to sync logs." });
  }
});

// ---- 统一的 JSON 兜底 ----
// 若不显式处理，未知 /api 路由会落到 Express 的 HTML 404，请求体解析失败或处理器抛错
// 则由默认错误处理器渲染出带**绝对安装路径**与完整调用栈的 HTML 页面 ——
// 既与其它端点的 `{error}` 契约不一致，也把本机目录结构暴露给了调用方。
app.use("/api", (req: Request, res: Response) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});

app.use((error: Error & { status?: number; type?: string }, req: Request, res: Response, next: (error?: unknown) => void) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  // 请求体不是合法 JSON / 超出大小限制，属于调用方的输入错误，不是服务端故障。
  const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
  const message = status === 400
    ? "Request body must be valid JSON."
    : "Internal server error.";
  console.error(`Request failed (${req.method} ${req.path}):`, error.message);
  res.status(status).json({ error: message });
});

function startLogSyncTimer(): void {
  if (syncTimer) {
    return;
  }
  syncTimer = setInterval(() => {
    syncAllPlatforms().catch((error) => console.error("Scheduled log sync failed:", error));
  }, LOG_SYNC_INTERVAL_MS);
  syncTimer.unref();
}

async function loadAllProjectRealPaths(): Promise<Map<string, string>> {
  // 所有平台的 cwd 映射合并到同一张表：同名项目（同一 cwd 编码）自然合并，
  // 某个平台独有的项目也能显示真实路径，而不是回退到字符串解码。
  const map = new Map<string, string>();
  for (const adapter of listAdapters()) {
    await mergeProjectRealPaths(map, adapter);
  }
  return map;
}

/** 把某个平台的 cwd 映射并入给定表（已存在的键不覆盖）。 */
async function mergeProjectRealPaths(
  map: Map<string, string>,
  adapter: PlatformAdapter,
): Promise<void> {
  if (!adapter.loadProjectRealPaths) return;
  try {
    for (const [encoded, realPath] of await adapter.loadProjectRealPaths()) {
      if (!map.has(encoded)) map.set(encoded, realPath);
    }
  } catch (error) {
    console.error(`Failed to load ${adapter.label} project paths:`, error);
  }
}

async function startServer(): Promise<http.Server> {
  projectRealPaths = await loadAllProjectRealPaths();
  const httpServer = await new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => {
      console.log(`TokenTracker server listening on http://${HOST}:${PORT}`);
      resolve(server);
    });
    server.once("error", reject);
  });
  startLogSyncTimer();
  ensureInitialSync().catch((error) => {
    console.error("Initial log sync failed:", error);
  });
  return httpServer;
}

async function stopServer(httpServer: http.Server): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (httpServer && httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
  await Promise.all(Array.from(syncPromises.values()).map((promise) => promise.catch(() => {})));
  await closeDatabase();
}

if (require.main === module) {
  startServer()
    .then((httpServer) => {
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down...`);
        try {
          await stopServer(httpServer);
          process.exitCode = 0;
        } catch (error) {
          console.error("Failed to shut down TokenTracker:", error);
          process.exitCode = 1;
        }
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error) => {
      console.error("Failed to start TokenTracker server:", error);
      process.exitCode = 1;
    });
}

export = {
  app,
  aggregateEvents,
  attachSessionCosts,
  importLogFile,
  listClaudeLogFiles,
  readCompleteChunk,
  syncClaudeLogs,
  syncCodexLogs,
  syncPlatform,
  syncAllPlatforms,
  startServer,
  stopServer,
};
