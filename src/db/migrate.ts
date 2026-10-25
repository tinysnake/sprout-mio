import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./connection";
import { config } from "../lib/config";

export function migrateDatabase(
  databaseUrl: string = config.DATABASE_URL,
  migrationsFolder = "drizzle",
): void {
  const { sqlite, db } = openDatabase(databaseUrl);
  try {
    // 迁移 SQL 里的表重建（PRAGMA foreign_keys=OFF 在事务内无效）必须以连接级关闭外键为前提，
    // 否则从零建库会静默跳过该 PRAGMA 并在 DROP TABLE 处撞上引用它的行。迁移结束后再校验。
    sqlite.pragma("foreign_keys = OFF");
    migrate(db, { migrationsFolder: resolve(migrationsFolder) });
    const violations = sqlite.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) throw new Error("迁移后外键校验失败");
  } finally {
    sqlite.pragma("foreign_keys = ON");
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    migrateDatabase();
    console.log("数据库迁移完成", config.DATABASE_URL);
  } catch (error) {
    console.error("数据库迁移失败", error instanceof Error ? error.message : "未知错误");
    process.exitCode = 1;
  }
}
