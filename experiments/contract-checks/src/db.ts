import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0000_petite_miss_america.sql',
);

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenOptions {
  // DELETE is the SQLite default. WAL permits readers during a write, so it is the
  // mode production will use; both are exercised by the concurrency checks.
  journalMode?: 'delete' | 'wal';
  busyTimeoutMs?: number;
}

export function migrate(sqlite: Database.Database): void {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) sqlite.exec(trimmed);
  }
}

export function openRaw(path: string, options: OpenOptions = {}): Database.Database {
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`journal_mode = ${options.journalMode ?? 'delete'}`);
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  return sqlite;
}

export function openMigrated(
  path: string,
  options: OpenOptions = {},
): { sqlite: Database.Database; db: Db } {
  const sqlite = openRaw(path, options);
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

// p0-b finding 5: Drizzle sometimes wraps the driver error, so the sqlite code can
// sit on error.code or error.cause.code.
export function sqliteErrorCode(error: unknown): string | undefined {
  const read = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  };
  return read(error) ?? read((error as { cause?: unknown })?.cause);
}

export function isConstraintError(error: unknown, code: string): boolean {
  return sqliteErrorCode(error) === code;
}
