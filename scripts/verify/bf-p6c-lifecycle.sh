#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# P6c 集成门禁：真实 SQLite 文件 + 真实生产函数，八条生命周期不变量逐条断言。
# 证据目录：base-commit、source-sha256.txt、exit-code，数据库文件留在同目录便于复查。
export P6C_EVIDENCE_DIR="${P6C_EVIDENCE_DIR:-$PWD/.verify/p6c-lifecycle}"
mkdir -p "$P6C_EVIDENCE_DIR"
git rev-parse HEAD > "$P6C_EVIDENCE_DIR/base-commit"
{
  git ls-files -z src drizzle package.json pnpm-lock.yaml | xargs -0 shasum -a 256
  shasum -a 256 tests/fixtures/p6c-lifecycle.ts \
    tests/fixtures/p6c-lifecycle-worker.ts \
    tests/fixtures/p6a-continuation-runner.mjs \
    scripts/verify/bf-p6c-lifecycle.sh
} > "$P6C_EVIDENCE_DIR/source-sha256.txt"
export DATABASE_URL="$P6C_EVIDENCE_DIR/lifecycle.sqlite"
# 每次从空库开始：本门禁自己迁移、自己种夹具，不做增量重跑。
rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6C_EVIDENCE_DIR/p6c-interrupt.marker"
export NODE_ENV=test SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')}"
status=0
node --import tsx tests/fixtures/p6c-lifecycle.ts || status=$?
printf '%s\n' "$status" > "$P6C_EVIDENCE_DIR/exit-code"
exit "$status"
