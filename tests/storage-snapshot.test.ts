import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { backupDatabase, inspectDatabase, restoreDatabase } from "../scripts/p7/storage/snapshot";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "p7-storage-snapshot-"));
  directories.push(directory);
  return directory;
}

describe("SQLite 一致快照", () => {
  it("VACUUM INTO 包含 WAL 中已提交事务，直接复制主库文件会丢掉它们", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "live.sqlite");
    const sqlite = new Database(source);
    try {
      sqlite.pragma("journal_mode = WAL");
      // 固定断言：提交留在 WAL 里，不因自动 checkpoint 偶发通过或失败。
      sqlite.pragma("wal_autocheckpoint = 0");
      sqlite.exec("CREATE TABLE probe(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
      sqlite.prepare("INSERT INTO probe(id, body) VALUES (?, ?)").run("base", "已落主库");
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      sqlite
        .prepare("INSERT INTO probe(id, body) VALUES (?, ?)")
        .run("wal_only", "提交在 WAL，尚未 checkpoint");

      const copiedMainFile = join(directory, "copy.sqlite");
      copyFileSync(source, copiedMainFile);
      const copy = new Database(copiedMainFile, { readonly: true, fileMustExist: true });
      try {
        expect(copy.prepare("SELECT id FROM probe ORDER BY id").all()).toEqual([{ id: "base" }]);
      } finally {
        copy.close();
      }

      const snapshot = backupDatabase({
        database: source,
        out: join(directory, "snapshot.sqlite"),
      });
      expect(snapshot.integrity).toBe("ok");
      expect(snapshot.foreignKeyViolations).toBe(0);
      expect(snapshot.tables.probe).toBe(2);
      const restored = restoreDatabase({
        backup: snapshot.path,
        database: join(directory, "restored", "app.sqlite"),
      });
      expect(restored.tables.probe).toBe(2);
      const restoredDatabase = new Database(restored.path, { readonly: true });
      try {
        expect(restoredDatabase.prepare("SELECT id FROM probe ORDER BY id").all()).toEqual([
          { id: "base" },
          { id: "wal_only" },
        ]);
      } finally {
        restoredDatabase.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it("恢复拒绝已有目标与损坏备份，不把半写文件放进服务会打开的位置", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "live.sqlite");
    const sqlite = new Database(source);
    sqlite.exec("CREATE TABLE probe(id TEXT PRIMARY KEY)");
    sqlite.prepare("INSERT INTO probe(id) VALUES ('base')").run();
    sqlite.close();
    const snapshot = backupDatabase({
      database: source,
      out: join(directory, "snapshot.sqlite"),
    });
    const target = join(directory, "restored", "app.sqlite");
    restoreDatabase({ backup: snapshot.path, database: target });
    expect(() => restoreDatabase({ backup: snapshot.path, database: target })).toThrow(/已存在/);

    const corrupt = join(directory, "corrupt.sqlite");
    writeFileSync(corrupt, "not a sqlite database");
    expect(() =>
      restoreDatabase({ backup: corrupt, database: join(directory, "never", "app.sqlite") }),
    ).toThrow();
  });

  it("inspect 报告迁移数与关键表行数，不修改被检文件", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "live.sqlite");
    const sqlite = new Database(source);
    sqlite.exec(
      "CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER); INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('a', 1), ('b', 2); CREATE TABLE project(id TEXT PRIMARY KEY); INSERT INTO project(id) VALUES ('prj_one'), ('prj_two');",
    );
    sqlite.close();
    const first = inspectDatabase(source);
    const second = inspectDatabase(source);
    expect(first.migrations).toBe(2);
    expect(first.latestMigrationAt).toBe(2);
    expect(first.tables.project).toBe(2);
    expect(second.sha256).toBe(first.sha256);
  });
});
