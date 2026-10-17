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
    migrate(db, { migrationsFolder: resolve(migrationsFolder) });
  } finally {
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
