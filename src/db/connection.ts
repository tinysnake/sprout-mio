import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export function openDatabase(databaseUrl: string) {
  if (databaseUrl !== ":memory:") mkdirSync(dirname(databaseUrl), { recursive: true });
  const sqlite = new Database(databaseUrl);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("journal_mode = WAL");
    return { sqlite, db: drizzle(sqlite, { schema }) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
