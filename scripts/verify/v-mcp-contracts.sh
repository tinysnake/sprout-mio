#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p .verify/v-mcp-contracts
export DATABASE_URL="$PWD/.verify/v-mcp-contracts/verification.sqlite"
export NODE_ENV=test
trap 'printf "FAIL MCP contracts verification\n" >&2' ERR
rm -f "$DATABASE_URL" "$DATABASE_URL-shm" "$DATABASE_URL-wal"
pnpm exec tsx tests/mcp-contracts.test.ts
printf 'PASS MCP schemas and isolated SQLite counterexamples\n'
pnpm exec tsx src/db/migrate.ts
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
const sqlite = new Database(process.env.DATABASE_URL);
try {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all();
  // 表数从迁移文件推导，不写死常量：新增迁移时这里不该再改。
  // 重建与改名的写法是 `CREATE TABLE __new_x` / `DROP TABLE old` / `ALTER TABLE ...
  // RENAME TO x`，所以三条语句要按文件内的先后顺序一起吃，否则改名迁移会被算成
  // 「凭空留下一张旧表」。
  const normalize = (name) => (name.startsWith('__new_') ? name.slice(6) : name);
  const created = new Set();
  const statements =
    /(CREATE TABLE|DROP TABLE)(?: IF NOT EXISTS| IF EXISTS)? `([a-z_0-9]+)`|ALTER TABLE `([a-z_0-9]+)` RENAME TO `([a-z_0-9]+)`/g;
  for (const file of readdirSync('drizzle').filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(`drizzle/${file}`, 'utf8');
    for (const match of sql.matchAll(statements)) {
      if (match[1] === undefined) {
        created.delete(normalize(match[3]));
        created.add(match[4]);
      } else if (match[1] === "DROP TABLE") {
        created.delete(normalize(match[2]));
      } else {
        const name = normalize(match[2]);
        if (!name.startsWith('__')) created.add(name);
      }
    }
  }
  assert.deepEqual(tables.map((table) => table.name).sort(), [...created].sort());
  for (const name of ['mcp_server_registration', 'mcp_server_process', 'mcp_session', 'mcp_frame']) assert(tables.some((table) => table.name === name));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get().n, readdirSync('drizzle').filter((file) => file.endsWith('.sql')).length);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  console.log(`PASS empty database migrations; ${tables.length} application tables match migration files; migration ledger equals SQL file count`);
} finally { sqlite.close(); }
NODE
pnpm typecheck
printf 'PASS MCP typecheck\n'
