// 平台适配器的公共契约与工具函数。
//
// TokenTracker 支持多个「AI 编码 CLI / IDE」，它们各自把会话日志放在不同位置、
// 用不同字段记录 token。这里把差异全部收敛到一个 PlatformAdapter 接口里：
// 数据在哪（rootDir）、怎么列文件（listFiles）、怎么解析出 token 事件（parseFile）、
// 会话详情页怎么回读原文（loadPrompts）。server.ts 只依赖这个接口，
// 因此**新增一个平台 = 新增一个适配器**，同步逻辑与 REST 接口都不用改。
//
// 数据一律只保留 token 计数、模型名、项目名与相对日志路径，正文按需回读、不落库。

import * as fs from "fs";
import * as path from "path";
import type { Segment, SessionSummary, UsageEvent } from "./types";

/** 一个待解析的源文件（storedPath 为相对平台根目录的路径，入库时不泄露绝对路径）。 */
export interface PlatformFileInfo {
  filePath: string;
  storedPath: string;
  projectName: string;
  sessionId: string;
  modifiedTimeMs: number;
  fileSize: number;
}

/** 一条事件的对话原文分段（按需回读，不入库）。 */
export interface PromptSegments {
  userSegments: Segment[];
  assistantSegments: Segment[];
}

export interface ParsedPlatformLog {
  session: SessionSummary;
  events: UsageEvent[];
  invalidLines: number;
  usageRecords: number;
  duplicateRecords: number;
  prompts?: Map<string, PromptSegments>;
}

export interface ParseOptions {
  withPrompts?: boolean;
}

/** 增量解析器：逐行喂入，最后 finish 出结果（仅 incremental 模式使用）。 */
export interface IncrementalParser {
  /**
   * 喂入一行。
   * `lineOffset` 是该行在文件中的起始字节偏移。解析器在记录本身没有任何 id 字段时
   * 用它生成稳定的兜底事件 id —— 增量续读每次都新建解析器，用「本实例第几行」
   * 会在不同批次间碰撞，导致后一次同步覆盖前一次的行。
   */
  addLine(line: string, lineOffset?: number): void;
  finish(): ParsedPlatformLog;
}

export interface PlatformAdapter {
  /** 平台标识，写入 usage_events.platform，同时作为前端筛选值。 */
  id: string;
  /** 展示名（产品名，不做翻译）。 */
  label: string;
  /** 数据根目录（绝对路径）。 */
  rootDir: string;
  /** 可通过该环境变量覆盖 rootDir（便于测试与自定义安装位置）。 */
  envVar: string;
  /**
   * incremental —— 日志只追加，可按字节偏移续读（源文件格式天然可续）。
   * rebuild     —— 每次变更整份重解析（累计值差分、单库聚合等无法中途续读）。
   */
  mode: "incremental" | "rebuild";
  /** 数据目录（或数据库文件）当前是否存在。 */
  isAvailable(): boolean;
  /** 列出全部源文件。 */
  listFiles(): Promise<PlatformFileInfo[]>;
  /** 全量解析单个源文件（SQLite 型平台可能返回 Promise）。 */
  parseFile(file: PlatformFileInfo, options?: ParseOptions): ParsedPlatformLog | null | Promise<ParsedPlatformLog | null>;
  /** 增量模式下提供逐行解析器；缺省则退化为整份重建。 */
  createIncrementalParser?(file: PlatformFileInfo): IncrementalParser;
  /** 「编码项目名 -> 真实 cwd」映射，用于把项目名还原成可读路径。 */
  loadProjectRealPaths?(): Map<string, string> | Promise<Map<string, string>>;
  /**
   * 会话详情页回读原文分段。sourceFiles 为该会话入库时记录下的相对路径列表
   * （由 database.getSessionSourceFiles 提供），平台不提供时返回空表。
   */
  loadPrompts?(sessionId: string, projectName: string, sourceFiles: string[]): Promise<Map<string, PromptSegments>>;
}

/** 缺省实现：storedPath 相对 rootDir 还原为绝对路径。 */
export function defaultResolveSourcePath(rootDir: string, storedPath: string): string {
  return path.isAbsolute(storedPath) ? storedPath : path.join(rootDir, storedPath);
}

/** 缺省实现：绝对路径转相对 rootDir 的路径（保持 / 分隔，避免泄露用户名）。 */
export function defaultToStoredPath(rootDir: string, absolutePath: string): string {
  try {
    return path.relative(rootDir, absolutePath).split(path.sep).join("/");
  } catch {
    return absolutePath;
  }
}

export function toTokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/**
 * 把日志里的时间戳归一成 ISO 字符串。
 * 各平台写法不一：Claude 用 ISO 字符串，WorkBuddy/CodeBuddy 用毫秒整数，
 * Qoder 用 ISO，ZCode 用 ISO。数字同时兼容秒（10 位）与毫秒（13 位）。
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const milliseconds = raw < 1e12 ? raw * 1000 : raw;
    const fromEpoch = new Date(milliseconds);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch.toISOString();
  }
  const timestamp = new Date(String(value));
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

/**
 * 把真实 cwd 编码成 Claude Code 的项目目录名格式（':' '\' '/' '_' 全部变 '-'）。
 * 所有平台共用同一套编码，同一个工作目录在不同平台下会归到同一个 projectName，
 * 项目成本中心才能跨平台合并统计。
 */
export function encodeProjectName(cwd: unknown): string {
  if (!cwd || typeof cwd !== "string") return "unknown";
  return cwd.replace(/[:\\/_]/g, "-");
}

/** 递归收集 dir 下满足 accept 的文件（accept 收到相对 dir 的 / 分隔路径）。 */
export function walkFiles(
  dir: string,
  accept: (relativePath: string) => boolean,
): Array<{ filePath: string; relativePath: string; stats: fs.Stats }> {
  const results: Array<{ filePath: string; relativePath: string; stats: fs.Stats }> = [];
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: dir, relative: "" }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!entry.isFile() || !accept(relative)) continue;
      try {
        results.push({ filePath: absolute, relativePath: relative, stats: fs.statSync(absolute) });
      } catch {
        // 单个文件读取失败不影响其余文件
      }
    }
  }
  return results;
}

/**
 * 读取文件头部并抽出第一个 cwd 字段。
 * 会话日志的每条记录通常都带 cwd，因此只读文件头即可，不必整份解析。
 * 注意首条记录可能是很长的用户消息（cwd 排在 content 之后），
 * 所以这里默认读 512KB 而不是几 KB，否则会漏判、退化成可读性很差的字符串解码结果。
 */
export function readCwdFromFileHeader(filePath: string, bytes = 512 * 1024): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const match = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1].replace(/\\\\/g, "\\");
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取文件首行并解析为 JSON（拿 sessionId / cwd / model 等元信息）。 */
export function readFirstJsonLine(filePath: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    const firstLine = newline === -1 ? text : text.slice(0, newline);
    if (!firstLine.trim()) return null;
    const parsed: unknown = JSON.parse(firstLine);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** 解析会话文件名里的 session id（去掉 Qoder 的 `session-`、Codex 的 rollout- 前缀）。 */
export function sessionIdFromFileName(fileName: string): string {
  const base = fileName.replace(/\.jsonl$/i, "").replace(/^session-/, "");
  const rollout = base.replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, "");
  return rollout || base;
}
