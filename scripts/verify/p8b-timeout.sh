#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P8b 挂靠超时提醒 / 升级（T1–T12）与申请遇阻等待（N1–N8）的验收门禁（契约 + 域层）。
# 真实 SQLite、真实 Project/Group/分身身份与真实租约；时限由 Project 覆盖压到秒级，
# 所以这里跑的是同一套产品代码路径。私有库与会话都留在 mktemp 目录里。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p8b-timeout.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

# 1) 0038 迁移 + 域层：计时起点=挂靠被接受时刻、只提醒一次、owner 类型分流（Agent 唤醒 /
#    人类只发 chat 消息）、2 小时升级、T10「暂停不影响超时与升级」、超时只加只读标记不释放租约、
#    唤醒失败复用既有 agent-run 重试规则。
DATABASE_URL="$verification_dir/domain.sqlite" node --import tsx src/db/migrate.ts
DATABASE_URL="$verification_dir/domain.sqlite" \
  pnpm exec vp test run tests/p8b-timeout-domain.test.ts

# 2) 阻塞式等待：N1 可等待判定、默认 5 分钟与 1 小时钳断、等待期间不打扰持有者、
#    到点同步返回失败 + 原因、同一身份阻塞期间不接其他工作（在内存中，不落库）。
DATABASE_URL="$verification_dir/wait.sqlite" \
  pnpm exec vp test run tests/p8b-lease-wait.test.ts

printf 'PASS P8b lease timeout reminder/escalation and blocking wait: 0038 migration, deadline from\n'
printf '     escrowedAt, remind-once, agent-owner wake vs human-owner chat-only, 2h escalation with\n'
printf '     paused owner attempts, T10 pause exception, lease occupancy unchanged, existing retry\n'
printf '     cadence reuse, 5min default with 1h clamp, and timeout returning failure with reason\n'
