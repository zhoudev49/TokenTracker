// 平台注册表：所有被支持的「AI 编码 CLI / IDE」在这里登记。
//
// 现状一览（`~/.<tool>/` 下的数据位置）：
//   claude     Claude Code            ~/.claude/projects/<编码cwd>/*.jsonl
//   codex      OpenAI Codex CLI       ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl
//   workbuddy  WorkBuddy              ~/.workbuddy/projects/<编码cwd>/<session>.jsonl
//   codebuddy  CodeBuddy Code         ~/.codebuddy/projects/<编码cwd>/<session>.jsonl
//   qoder      Qoder CLI              ~/.qoder/projects/<编码cwd>/*.jsonl
//                                     ~/.qoder/logs/sessions/<sid>/segments/*.jsonl
//   qwen       Qwen Code CLI          ~/.qwen/projects/<编码cwd>/*.jsonl
//   zcode      ZCode (GLM)            ~/.zcode/cli/db/db.sqlite
//   opencode   OpenCode               $XDG_DATA_HOME/opencode/opencode.db
//
// WorkBuddy / CodeBuddy / Qoder / Qwen 都沿用了 Claude Code 的会话日志骨架，
// 因此共用 claude-jsonl-parser.ts 这一份解析器；zcode / opencode 是 SQLite，
// 各自有专属读取器。**新增同类平台通常只需在下面加一行 addClaudeJsonlPlatform(...)。**

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createClaudeJsonlParser, parseClaudeJsonlFile } from "./claude-jsonl-parser";
import { createUsageRecordParser, parseUsageRecords } from "./log-parser";
import {
  defaultResolveSourcePath,
  defaultToStoredPath,
  encodeProjectName,
  readCwdFromFileHeader,
  sessionIdFromFileName,
  walkFiles,
  type IncrementalParser,
  type ParsedPlatformLog,
  type ParseOptions,
  type PlatformAdapter,
  type PlatformFileInfo,
  type PromptSegments,
} from "./platform-adapter";
import { CODEX_SESSIONS_DIR, listCodexSessionFiles, loadCodexProjectRealPaths, parseCodexSessionFile } from "./codex-parser";
import {
  OPENCODE_DATABASE_PATH,
  loadOpenCodeProjectRealPaths,
  openCodeFileInfo,
  readOpenCodeDatabase,
} from "./opencode-parser";
import { ZCODE_DATABASE_PATH, loadZCodeProjectRealPaths, readZCodeDatabase, zcodeFileInfo } from "./zcode-parser";

export type { PlatformAdapter, PlatformFileInfo, ParsedPlatformLog, PromptSegments } from "./platform-adapter";

function envDir(envVar: string, fallback: string): string {
  const override = process.env[envVar];
  return override ? path.resolve(override) : fallback;
}

// ---------------------------------------------------------------------------
// Claude 形态 JSONL：一个工厂覆盖 WorkBuddy / CodeBuddy / Qoder / Qwen 等
// ---------------------------------------------------------------------------

interface ClaudeJsonlPlatformConfig {
  id: string;
  label: string;
  rootDir: string;
  envVar: string;
  /** 是否接收某个相对路径的源文件（默认为 projects/ 下的 .jsonl）。 */
  accept?: (relativePath: string) => boolean;
  /**
   * 由相对路径推导「编码项目名」。返回 null 表示该文件不属于任何项目，跳过。
   * 默认取 projects/ 后的第一段。
   */
  projectNameFromPath?: (relativePath: string) => string | null;
  /**
   * 由相对路径推导 sessionId（仅作兜底，记录里的 sessionId 优先）。
   * 默认取文件名；嵌套目录（如 <session>/subagents/agent-x.jsonl）取会话目录名。
   */
  sessionIdFromPath?: (relativePath: string) => string;
  /**
   * 记录里的 usage 不在 message.usage 时，允许额外把整条记录交给归一函数。
   * 用于 Qoder 的 model.response.completed（用量在 data 里）。
   */
  extraUsageFromRecord?: (record: Record<string, unknown>) => unknown;
}

function createClaudeJsonlPlatform(config: ClaudeJsonlPlatformConfig): PlatformAdapter {
  // 默认约定：rootDir 指向 `<tool>/projects`，其下每个子目录是一个「编码 cwd」项目。
  const accept = config.accept || ((relativePath: string) => relativePath.endsWith(".jsonl"));
  const projectNameFromPath = config.projectNameFromPath || ((relativePath: string) => {
    const segments = relativePath.split("/");
    return segments.length >= 2 ? segments[0] : null;
  });
  const sessionIdFromPath = config.sessionIdFromPath || ((relativePath: string) => {
    const segments = relativePath.split("/");
    // <project>/<session>/subagents/x.jsonl → 会话目录；<project>/<session>.jsonl → 文件名
    return segments.length > 2 ? segments[1] : sessionIdFromFileName(segments[segments.length - 1]);
  });

  function listFiles(): PlatformFileInfo[] {
    const files: PlatformFileInfo[] = [];
    for (const entry of walkFiles(config.rootDir, accept)) {
      const projectName = projectNameFromPath(entry.relativePath);
      if (!projectName) continue;
      files.push({
        filePath: entry.filePath,
        storedPath: entry.relativePath,
        projectName,
        sessionId: sessionIdFromPath(entry.relativePath),
        modifiedTimeMs: entry.stats.mtimeMs,
        fileSize: entry.stats.size,
      });
    }
    return files;
  }

  return {
    id: config.id,
    label: config.label,
    rootDir: config.rootDir,
    envVar: config.envVar,
    // 这类日志只追加新行，可按字节偏移续读；解析器按消息 id 去重，重复喂入是幂等的。
    mode: "incremental",
    isAvailable(): boolean {
      try {
        return fs.statSync(config.rootDir).isDirectory();
      } catch {
        return false;
      }
    },
    async listFiles() {
      return listFiles();
    },
    parseFile(file: PlatformFileInfo, options: ParseOptions = {}): ParsedPlatformLog | null {
      let content: string;
      try {
        content = fs.readFileSync(file.filePath, "utf8");
      } catch {
        return null;
      }
      return parseClaudeJsonlFile(content, file, config.id, {
        ...options,
        extraUsageFromRecord: config.extraUsageFromRecord,
      });
    },
    createIncrementalParser(file: PlatformFileInfo): IncrementalParser {
      return createClaudeJsonlParser(file, config.id, { extraUsageFromRecord: config.extraUsageFromRecord });
    },
    loadProjectRealPaths(): Map<string, string> {
      const map = new Map<string, string>();
      for (const entry of walkFiles(config.rootDir, accept)) {
        const projectName = projectNameFromPath(entry.relativePath);
        if (!projectName || map.has(projectName)) continue;
        const cwd = readCwdFromFileHeader(entry.filePath);
        if (cwd) map.set(projectName, cwd);
      }
      return map;
    },
    async loadPrompts(_sessionId: string, _projectName: string, sourceFiles: string[]): Promise<Map<string, PromptSegments>> {
      return loadClaudeJsonlPrompts(config.rootDir, sourceFiles, config.id);
    },
  };
}

/** 回读 Claude 形态日志的会话正文：整份重解析并打开 withPrompts。 */
function loadClaudeJsonlPrompts(rootDir: string, sourceFiles: string[], platformId: string): Map<string, PromptSegments> {
  const prompts = new Map<string, PromptSegments>();
  for (const storedPath of sourceFiles) {
    let content: string;
    try {
      content = fs.readFileSync(defaultResolveSourcePath(rootDir, storedPath), "utf8");
    } catch {
      continue;
    }
    const file: PlatformFileInfo = {
      filePath: defaultResolveSourcePath(rootDir, storedPath),
      storedPath,
      projectName: "",
      sessionId: "",
      modifiedTimeMs: 0,
      fileSize: 0,
    };
    const parsed = parseClaudeJsonlFile(content, file, platformId, { withPrompts: true });
    if (parsed.prompts) {
      for (const [messageId, segments] of parsed.prompts) prompts.set(messageId, segments);
    }
  }
  return prompts;
}

// ---------------------------------------------------------------------------
// 各平台登记
// ---------------------------------------------------------------------------

/** Claude Code：沿用 log-parser 的增量语义，事件 key 不带平台前缀以兼容既有数据库。 */
const claudeAdapter: PlatformAdapter = {
  id: "claude",
  label: "Claude Code",
  // 注意：必须在模块加载时读取 env（测试会在 require 之前设置该变量）。
  rootDir: envDir("TOKEN_TRACKER_CLAUDE_PROJECTS_DIR", path.join(os.homedir(), ".claude", "projects")),
  envVar: "TOKEN_TRACKER_CLAUDE_PROJECTS_DIR",
  mode: "incremental",
  isAvailable(): boolean {
    try {
      return fs.statSync(claudeAdapter.rootDir).isDirectory();
    } catch {
      return false;
    }
  },
  async listFiles(): Promise<PlatformFileInfo[]> {
    // Claude 的项目目录是 <编码cwd>/<session>.jsonl，还可能嵌套
    // <session>/subagents/agent-*.jsonl（会话内的子代理），需递归收集。
    const files: PlatformFileInfo[] = [];
    for (const entry of walkFiles(claudeAdapter.rootDir, (relativePath) => relativePath.endsWith(".jsonl"))) {
      const segments = entry.relativePath.split("/");
      if (segments.length < 2) continue;
      files.push({
        filePath: path.join(claudeAdapter.rootDir, entry.relativePath),
        storedPath: entry.relativePath,
        projectName: segments[0],
        sessionId: segments.length > 2 ? segments[1] : sessionIdFromFileName(segments[segments.length - 1]),
        modifiedTimeMs: entry.stats.mtimeMs,
        fileSize: entry.stats.size,
      });
    }
    return files;
  },
  parseFile(file: PlatformFileInfo): ParsedPlatformLog | null {
    let content: string;
    try {
      content = fs.readFileSync(file.filePath, "utf8");
    } catch {
      return null;
    }
    return parseUsageRecords(content, { ...file, filePath: file.storedPath || file.filePath });
  },
  createIncrementalParser(file: PlatformFileInfo): IncrementalParser {
    // 沿用既有 log-parser：事件 key 不带平台前缀，保持与历史数据库完全兼容。
    return createUsageRecordParser({ ...file, filePath: file.storedPath || file.filePath });
  },
  loadProjectRealPaths(): Map<string, string> {
    const map = new Map<string, string>();
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(claudeAdapter.rootDir, { withFileTypes: true });
    } catch {
      return map;
    }
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(claudeAdapter.rootDir, dir.name);
      let realPath: string | null = null;
      try {
        for (const file of fs.readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"))) {
          realPath = readCwdFromFileHeader(path.join(projectDir, file));
          if (realPath) break;
        }
      } catch {
        // 单个目录读取失败不影响其余映射
      }
      if (realPath) map.set(dir.name, realPath);
    }
    return map;
  },
  async loadPrompts(_sessionId: string, _projectName: string, sourceFiles: string[]): Promise<Map<string, PromptSegments>> {
    return loadClaudeJsonlPrompts(claudeAdapter.rootDir, sourceFiles, "claude");
  },
};

/** OpenAI Codex CLI：rollout 文件是累计快照，必须整份重新差分。 */
const codexAdapter: PlatformAdapter = {
  id: "codex",
  label: "Codex",
  rootDir: CODEX_SESSIONS_DIR,
  envVar: "TOKEN_TRACKER_CODEX_SESSIONS_DIR",
  mode: "rebuild",
  isAvailable(): boolean {
    try {
      return fs.statSync(CODEX_SESSIONS_DIR).isDirectory();
    } catch {
      return false;
    }
  },
  async listFiles(): Promise<PlatformFileInfo[]> {
    return listCodexSessionFiles().map((file) => ({
      filePath: file.filePath,
      storedPath: file.storedPath,
      projectName: "",
      sessionId: sessionIdFromFileName(path.basename(file.filePath)),
      modifiedTimeMs: file.modifiedTimeMs,
      fileSize: file.fileSize,
    }));
  },
  parseFile(file: PlatformFileInfo, options: ParseOptions = {}): ParsedPlatformLog | null {
    const parsed = parseCodexSessionFile(file.filePath, {
      storedPath: file.storedPath,
      withPrompts: options.withPrompts === true,
    });
    if (!parsed) return null;
    return {
      session: parsed.session,
      events: parsed.events,
      invalidLines: parsed.invalidLines,
      usageRecords: parsed.usageRecords,
      duplicateRecords: parsed.duplicateRecords,
      prompts: parsed.prompts,
    };
  },
  loadProjectRealPaths(): Map<string, string> {
    return loadCodexProjectRealPaths();
  },
  async loadPrompts(_sessionId: string, _projectName: string, sourceFiles: string[]): Promise<Map<string, PromptSegments>> {
    const prompts = new Map<string, PromptSegments>();
    for (const storedPath of sourceFiles) {
      const parsed = parseCodexSessionFile(defaultResolveSourcePath(CODEX_SESSIONS_DIR, storedPath), {
        storedPath,
        withPrompts: true,
      });
      if (!parsed) continue;
      for (const [messageId, segments] of parsed.prompts) prompts.set(messageId, segments);
    }
    return prompts;
  },
};

/** 单库型平台（ZCode / OpenCode）：数据库整体当作一个源文件，每次变更整份重建。 */
function createSqlitePlatform(config: {
  id: string;
  label: string;
  databasePath: string;
  envVar: string;
  reader: (databasePath: string) => Promise<ParsedPlatformLog>;
  fileInfo: (databasePath: string) => PlatformFileInfo | null;
  realPaths: (databasePath: string) => Promise<Map<string, string>>;
}): PlatformAdapter {
  return {
    id: config.id,
    label: config.label,
    rootDir: config.databasePath,
    envVar: config.envVar,
    mode: "rebuild",
    isAvailable(): boolean {
      try {
        return fs.statSync(config.databasePath).isFile();
      } catch {
        return false;
      }
    },
    async listFiles(): Promise<PlatformFileInfo[]> {
      const info = config.fileInfo(config.databasePath);
      return info ? [info] : [];
    },
    async parseFile(file: PlatformFileInfo): Promise<ParsedPlatformLog | null> {
      try {
        return await config.reader(file.filePath);
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    async loadProjectRealPaths(): Promise<Map<string, string>> {
      return config.realPaths(config.databasePath);
    },
  };
}

const workbuddyAdapter = createClaudeJsonlPlatform({
  id: "workbuddy",
  label: "WorkBuddy",
  rootDir: envDir("TOKEN_TRACKER_WORKBUDDY_PROJECTS_DIR", path.join(os.homedir(), ".workbuddy", "projects")),
  envVar: "TOKEN_TRACKER_WORKBUDDY_PROJECTS_DIR",
});

const codebuddyAdapter = createClaudeJsonlPlatform({
  id: "codebuddy",
  label: "CodeBuddy",
  rootDir: envDir("TOKEN_TRACKER_CODEBUDDY_PROJECTS_DIR", path.join(os.homedir(), ".codebuddy", "projects")),
  envVar: "TOKEN_TRACKER_CODEBUDDY_PROJECTS_DIR",
});

const qwenAdapter = createClaudeJsonlPlatform({
  id: "qwen",
  label: "Qwen Code",
  rootDir: envDir("TOKEN_TRACKER_QWEN_PROJECTS_DIR", path.join(os.homedir(), ".qwen", "projects")),
  envVar: "TOKEN_TRACKER_QWEN_PROJECTS_DIR",
});

/**
 * Qoder CLI：两处日志。
 *  - projects/<编码cwd>/<sid>.jsonl —— Claude 形态，正文与 token 同 Claude；
 *    （Qoder 官方在部分账号下把用量留在服务端，此时这些文件没有 token，会被自动跳过。）
 *  - logs/sessions/<sid>/segments/*.jsonl —— 事件流，model.response.completed 带 token 字段。
 * 两个来源的会话 id 相同，但事件 key 不同；由于缺 token 的记录不入库，
 * 同一会话不会因此被重复计数。
 */
const qoderConfig: ClaudeJsonlPlatformConfig = {
  id: "qoder",
  label: "Qoder",
  rootDir: envDir("TOKEN_TRACKER_QODER_DIR", path.join(os.homedir(), ".qoder")),
  envVar: "TOKEN_TRACKER_QODER_DIR",
  accept: (relativePath) =>
    relativePath.endsWith(".jsonl")
    && (relativePath.startsWith("projects/") || /^logs\/sessions\/[^/]+\/segments\/[^/]+\.jsonl$/.test(relativePath)),
  projectNameFromPath: (relativePath) => {
    if (relativePath.startsWith("projects/")) {
      const segments = relativePath.split("/");
      return segments.length >= 2 ? segments[1] : null;
    }
    // segments 日志的目录里没有 cwd，先按会话目录占位，
    // 由 listFiles 之后用 projects 树补齐真实项目名（见 enrichQoderSegments）。
    return null;
  },
  sessionIdFromPath: (relativePath) => {
    if (relativePath.startsWith("projects/")) {
      const segments = relativePath.split("/");
      return sessionIdFromFileName(segments[segments.length - 1]);
    }
    const match = relativePath.match(/^logs\/sessions\/([^/]+)\//);
    return match ? sessionIdFromFileName(match[1]) : sessionIdFromFileName(path.basename(relativePath));
  },
  extraUsageFromRecord: (record) => {
    const type = typeof record.type === "string" ? record.type : "";
    return type.startsWith("model.response") ? record.data : null;
  },
};

const qoderAdapterBase = createClaudeJsonlPlatform(qoderConfig);

/** Qoder 的 segments 日志没有 cwd：用 projects 树的「会话 id -> 项目目录名」映射补齐。 */
function buildQoderSessionProjects(): Map<string, string> {
  const map = new Map<string, string>();
  const projectsRoot = path.join(qoderConfig.rootDir, "projects");
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    try {
      for (const file of fs.readdirSync(path.join(projectsRoot, dir.name))) {
        if (file.endsWith(".jsonl")) map.set(sessionIdFromFileName(file), dir.name);
      }
    } catch {
      // 忽略单个项目目录的读取错误
    }
  }
  return map;
}

const qoderAdapter: PlatformAdapter = {
  ...qoderAdapterBase,
  async listFiles(): Promise<PlatformFileInfo[]> {
    const files: PlatformFileInfo[] = [];
    const projectNameOf = buildQoderSessionProjects();
    for (const entry of walkFiles(qoderConfig.rootDir, qoderConfig.accept!)) {
      const isProjectsFile = entry.relativePath.startsWith("projects/");
      const sessionId = qoderConfig.sessionIdFromPath!(entry.relativePath);
      const projectName = isProjectsFile
        ? qoderConfig.projectNameFromPath!(entry.relativePath)
        : projectNameOf.get(sessionId) || null;
      if (!projectName) continue;
      files.push({
        filePath: entry.filePath,
        storedPath: entry.relativePath,
        projectName,
        sessionId,
        modifiedTimeMs: entry.stats.mtimeMs,
        fileSize: entry.stats.size,
      });
    }
    return files;
  },
};

// ---------------------------------------------------------------------------
// 注册表 API
// ---------------------------------------------------------------------------

const ADAPTERS: PlatformAdapter[] = [
  claudeAdapter,
  codexAdapter,
  workbuddyAdapter,
  codebuddyAdapter,
  qoderAdapter,
  qwenAdapter,
  createSqlitePlatform({
    id: "zcode",
    label: "ZCode",
    databasePath: ZCODE_DATABASE_PATH,
    envVar: "TOKEN_TRACKER_ZCODE_DB",
    reader: readZCodeDatabase,
    fileInfo: zcodeFileInfo,
    realPaths: loadZCodeProjectRealPaths,
  }),
  createSqlitePlatform({
    id: "opencode",
    label: "OpenCode",
    databasePath: OPENCODE_DATABASE_PATH,
    envVar: "TOKEN_TRACKER_OPENCODE_DB",
    reader: readOpenCodeDatabase,
    fileInfo: openCodeFileInfo,
    realPaths: loadOpenCodeProjectRealPaths,
  }),
];

const ADAPTER_BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function listAdapters(): PlatformAdapter[] {
  return ADAPTERS;
}

export function getAdapter(platformId: string): PlatformAdapter | null {
  return ADAPTER_BY_ID.get(platformId) || null;
}

/** 各平台的探测结果，供 /api/platforms 与前端下拉使用。 */
export interface PlatformDescriptor {
  id: string;
  label: string;
  available: boolean;
  mode: "incremental" | "rebuild";
  envVar: string;
}

export function describeAdapters(): PlatformDescriptor[] {
  return ADAPTERS.map((adapter) => {
    let available = false;
    try {
      available = adapter.isAvailable();
    } catch {
      available = false;
    }
    return {
      id: adapter.id,
      label: adapter.label,
      available,
      mode: adapter.mode,
      envVar: adapter.envVar,
    };
  });
}

export {
  claudeAdapter,
  codexAdapter,
  workbuddyAdapter,
  codebuddyAdapter,
  qoderAdapter,
  qwenAdapter,
  defaultToStoredPath,
  defaultResolveSourcePath,
  encodeProjectName,
};
