#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P4d 归属裁决 / 移出 / 通知的验收门禁。
# 真实 SQLite、真实 Worker 网关与真实 Fn/HTTP 边界；私有库、会话 cookie 与命令正文都留在 mktemp。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p4d-int-authority.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
export P4D_STATE_FILE="$verification_dir/state.json"

# 1) 0020 迁移（空白库与含既有执行/日志/结果/MCP 历史的旧库）、直接 SQL 反证、契约与错误码登记。
DATABASE_URL="$verification_dir/contracts.sqlite" node --import tsx src/db/migrate.ts
DATABASE_URL="$verification_dir/contracts.sqlite" \
  pnpm exec vp test run tests/p4d-contracts.test.ts

# 2) 归属裁决、显式取消、跨代次 fence、迟到物理事实（域层，真实 SQLite + 真 Worker 网关）。
DATABASE_URL="$verification_dir/authority.sqlite" \
  pnpm exec vp test run tests/p4d-authority.test.ts

# 3) 移出、重新加入、通知投递、挂起投影与越权面。
DATABASE_URL="$verification_dir/removal.sqlite" \
  pnpm exec vp test run tests/p4d-removal.test.ts

# 4) 补充断言：伪造投递事实、fence ack 上界、同机双 Project、通知收件与重启一致、取消意图、真实边界错误码。
run_scenario() {
  local name="$1"
  local database="$2"
  shift 2
  DATABASE_URL="$verification_dir/$database" node --import tsx tests/fixtures/p4d-int-authority.ts "$@"
  printf 'PASS scenario %s\n' "$name"
}
run_scenario forged forged.sqlite forged
run_scenario pq pq.sqlite pq
run_scenario intent intent.sqlite intent
run_scenario notices notices.sqlite notices
run_scenario notices-restart notices.sqlite notices-restart
run_scenario pending-restart-setup pending.sqlite pending-restart-setup
run_scenario pending-restart-read pending.sqlite pending-restart-read
run_scenario http http.sqlite http
run_scenario steer steer.sqlite steer

printf 'PASS P4d authority, removal and notices: migration upgrade, SQL refusals, authority matrix,\n'
printf '     explicit cancellation, cross-generation fencing, late facts, detach/rejoin, same-machine\n'
printf '     isolation, notice recipients, pending boundary and real Fn/HTTP new error codes\n'
