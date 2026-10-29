#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Risk → Test
# 宿主只收到一部分帧就宣称日志完整 → 真实生产包 + 真实服务 + 私有 SQLite + 真实 Chromium +
#   真实 Worker 登记表/outbox + 真实子进程：
#   · 1.9 MB 快速输出在终态 ACK 时只送出前几批帧，冻结 Worker 保留 durable outbox；
#     API 与真实页面都必须是不完整，不得出现 logState=full。
#   · 恢复 Worker 补送后按默认 1 MiB 预算得到 truncated，ACK 覆盖全部产出，outbox 才清理。
#   · 小输出且 Worker 声明 sealed、全部 ACK 时，API 与页面才可以写「日志完整」。
#   · 反证：伪造 sealed 但 produced > acked 仍是 partial；缺帧补齐才变 full；收到 sealed=false
#     的事实后 full 回退为 partial；跨 holder 的日志位点事实被拒绝。
# 不缩小保留预算：默认 1 MiB / 512 帧必须成立。
# 私有库、会话 secret、runner token、命令与日志正文都留在临时目录，不进日志。
mkdir -p .verify
verification_dir="$(mktemp -d .verify/p4c-log-honesty.XXXXXX)"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
export DATABASE_URL="$verification_dir/log-honesty.sqlite"
export SPROUT_LOG_HONESTY_EVIDENCE="$verification_dir/evidence"
export BASE_URL="http://127.0.0.1:${SPROUT_LOG_HONESTY_PORT:-3152}"
export APP_ORIGIN="$BASE_URL"
export NODE_ENV=production
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

node scripts/verify/prepare.mjs server

node --import tsx tests/fixtures/execution-log-honesty.ts
printf 'PASS execution log honesty: paused outbox is not full, backfill trims, sealed+acked is full, forged sealed refused (evidence %s)\n' "$SPROUT_LOG_HONESTY_EVIDENCE"
