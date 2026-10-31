#!/usr/bin/env node
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 在线 SQLite 快照。`VACUUM INTO` 在一个读事务里写出新库，包含 WAL 中已提交但未 checkpoint
 * 的事务；直接复制主库文件会漏掉它们，见 tests/storage-snapshot.test.ts 的反证。
 *
 * 备份是单文件，不需要同时复制 `-wal`/`-shm` 侧车。恢复只接受新目标路径，先完整校验再
 * 原子改名，避免把半写文件放到服务会打开的位置。
 */
export type SnapshotReport = {
  path: string;
  bytes: number;
  sha256: string;
  integrity: string;
  foreignKeyViolations: number;
  migrations: number;
  latestMigrationAt: number | null;
  tables: Record<string, number>;
  createdAt: string;
};

export type RestoreReport = SnapshotReport & { restoredFrom: string };

function sha256File(file: string): string {
  const descriptor = openSync(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fsyncFile(file: string): void {
  const descriptor = openSync(file, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function inspectDatabase(file: string): SnapshotReport {
  const absolute = resolve(file);
  if (!existsSync(absolute)) throw new Error(`快照不存在: ${absolute}`);
  const sqlite = new Database(absolute, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("busy_timeout = 5000");
    const integrity = String(sqlite.pragma("integrity_check", { simple: true }));
    const foreignKeyViolations = (sqlite.pragma("foreign_key_check") as unknown[]).length;
    const tableNames = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const hasMigrations = tableNames.includes("__drizzle_migrations");
    const migration = hasMigrations
      ? (sqlite
          .prepare("SELECT count(*) AS count, max(created_at) AS latest FROM __drizzle_migrations")
          .get() as { count: number; latest: number | null })
      : { count: 0, latest: null };
    const tables: Record<string, number> = {};
    for (const table of tableNames.sort())
      tables[table] = (
        sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number }
      ).count;
    return {
      path: absolute,
      bytes: statSync(absolute).size,
      sha256: sha256File(absolute),
      integrity,
      foreignKeyViolations,
      migrations: migration.count,
      latestMigrationAt: migration.latest,
      tables,
      createdAt: new Date(statSync(absolute).mtimeMs).toISOString(),
    };
  } finally {
    sqlite.close();
  }
}

export function backupDatabase(input: { database: string; out: string }): SnapshotReport {
  const database = resolve(input.database);
  const out = resolve(input.out);
  if (!existsSync(database)) throw new Error(`源数据库不存在: ${database}`);
  if (existsSync(out)) throw new Error(`快照目标已存在，拒绝覆盖: ${out}`);
  mkdirSync(dirname(out), { recursive: true });
  const sqlite = new Database(database);
  try {
    sqlite.pragma("busy_timeout = 5000");
    // 参数绑定由 SQLite 解析为目标文件名；不要拼字符串，避免空格/引号改变语义。
    sqlite.prepare("VACUUM INTO ?").run(out);
  } finally {
    sqlite.close();
  }
  fsyncFile(out);
  const report = inspectDatabase(out);
  if (report.integrity !== "ok") throw new Error(`快照完整性校验失败: ${report.integrity}`);
  if (report.foreignKeyViolations > 0)
    throw new Error(`快照外键校验失败: ${report.foreignKeyViolations} 条`);
  return report;
}

export function restoreDatabase(input: { backup: string; database: string }): RestoreReport {
  const backup = resolve(input.backup);
  const database = resolve(input.database);
  if (existsSync(database)) throw new Error(`恢复目标已存在，拒绝覆盖: ${database}`);
  const verified = inspectDatabase(backup);
  if (verified.integrity !== "ok") throw new Error(`备份完整性校验失败: ${verified.integrity}`);
  if (verified.foreignKeyViolations > 0)
    throw new Error(`备份外键校验失败: ${verified.foreignKeyViolations} 条`);
  mkdirSync(dirname(database), { recursive: true });
  const temporary = `${database}.restoring-${process.pid}`;
  try {
    copyFileSync(backup, temporary);
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, database);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { ...inspectDatabase(database), restoredFrom: backup };
}

type Command = { command: "backup" | "restore" | "inspect"; options: Map<string, string> };

function parse(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command !== "backup" && command !== "restore" && command !== "inspect")
    throw new Error(
      "用法: snapshot.ts backup|restore|inspect --database <file> [--out <file> | --backup <file>]",
    );
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`未知参数: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${key} 缺少值`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`缺少 --${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, options } = parse(process.argv.slice(2));
    const report =
      command === "backup"
        ? backupDatabase({
            database: required(options, "database"),
            out: required(options, "out"),
          })
        : command === "restore"
          ? restoreDatabase({
              backup: required(options, "backup"),
              database: required(options, "database"),
            })
          : inspectDatabase(required(options, "database"));
    console.log(JSON.stringify({ command, ...report }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "未知错误");
    process.exitCode = 1;
  }
}
