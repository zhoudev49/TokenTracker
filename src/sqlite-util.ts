// 只读打开第三方工具的 SQLite 库。
// 部分平台（OpenCode、ZCode）不写 JSONL，而是把用量写进自己的 SQLite 库。
// 这里统一以 OPEN_READONLY 打开、只执行 SELECT。
//
// 安全约定：**只允许 OPEN_READONLY，任何情况下都不得回退到默认模式**。
// node-sqlite3 的默认模式是 OPEN_READWRITE | OPEN_CREATE —— 若回退到它，
// 就会在用户活跃的库旁创建 -wal/-shm、可能触发 WAL checkpoint（干扰甚至锁住被追踪的工具），
// 文件不存在时还会凭空新建一个库。这直接违背本工具「只读、绝不触碰第三方数据」的承诺。
// 打开失败就如实报错（会记录到 imported_logs 的 error 并在诊断接口暴露），不要静默降级。

import * as fs from "fs";
import sqlite3 = require("sqlite3");

export function openReadonly(databasePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (error) => {
      if (error) {
        reject(new Error(
          `无法以只读方式打开 ${databasePath}：${error.message}。`
          + "请确认该文件存在且当前用户可读（TokenTracker 不会以读写模式打开第三方数据库）。",
        ));
        return;
      }
      resolve(database);
    });
  });
}

export function all<T>(database: sqlite3.Database, sql: string, parameters: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error: Error | null, rows: T[]) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

/** 表是否存在（不同平台/版本的库结构会变，查询前先探测）。 */
export async function tableExists(database: sqlite3.Database, tableName: string): Promise<boolean> {
  try {
    const rows = await all<{ name: string }>(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => database.close(() => resolve()));
}

/**
 * 计算一个 SQLite 库的「变更签名」。
 * 这类库通常开启 WAL，新数据先写进 `-wal` 文件，主库的 mtime/size 可能长时间不变；
 * 只盯着主库会漏掉更新，因此把 `-wal` / `-shm` 也算进来。
 */
export function databaseFileSignature(databasePath: string): { modifiedTimeMs: number; fileSize: number } | null {
  const readStats = (target: string): fs.Stats | null => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  };

  const main = readStats(databasePath);
  if (!main) return null;

  let modifiedTimeMs = main.mtimeMs;
  let fileSize = main.size;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = readStats(`${databasePath}${suffix}`);
    if (!sidecar) continue;
    modifiedTimeMs = Math.max(modifiedTimeMs, sidecar.mtimeMs);
    fileSize += sidecar.size;
  }
  return { modifiedTimeMs, fileSize };
}
