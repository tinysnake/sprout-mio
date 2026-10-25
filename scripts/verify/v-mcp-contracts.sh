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
import { readdirSync } from 'node:fs';
const sqlite = new Database(process.env.DATABASE_URL);
try {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all();
  assert.equal(tables.length, 35);
  for (const name of ['mcp_server_registration', 'mcp_server_process', 'mcp_session', 'mcp_frame']) assert(tables.some((table) => table.name === name));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get().n, readdirSync('drizzle').filter((file) => file.endsWith('.sql')).length);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('PASS empty database migrations; 35 application tables; migration ledger equals SQL file count');
} finally { sqlite.close(); }
NODE
pnpm typecheck
printf 'PASS MCP typecheck\n'
