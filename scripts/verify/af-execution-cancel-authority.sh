#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 真实 SQLite + 真实 Web 边界：人类取消的 actor 归属、幂等重放、旧代次与跨用户拒绝、0015 迁移数据拷贝。
# 私有库、会话 cookie 与命令正文都留在 mktemp，不进日志。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-cancel-authority.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/cancel.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/execution-cancel-authority.ts
pnpm exec vp test run tests/execution-cancel-authority.test.ts
printf 'PASS execution cancel authority actor attribution, idempotency, refusal paths and 0015 data copy\n'
