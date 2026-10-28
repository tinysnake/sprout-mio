#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Risk → Test
# 取消幂等重放绕过代次与租约核对 → 真实 SQLite + 真实领域边界：当前代次入队成功、同代次重放
#   返回同一 cancelId、错代次重放是 lease_stale_generation（不写行、不写诊断）、租约换代次换
#   holder 后原代次重放被拒、另一个分身与另一用户重放被拒、终态执行只留原取消事实。
# 快速大输出丢尾部却标 logState=full → 真实 Worker outbox + 真实子进程 + 真实 runner：
#   1.8 MB 输出在默认保留预算下终态 ACK 时仍有未送达帧，最终 truncated + availableFrom>1，
#   取消旧游标被拒；终态 ACK 后立刻重启 Worker，新一代连接把剩余帧补送完才清理 outbox。
# 没有 durable result 的退出被当成 exited_observed → 同一门禁对照组：TERM 后自行退出且
#   runner 落盘结果 → 取消是 exited_observed；KILL 连 runner 一起打死（无 result.json）→
#   执行停在 unknown:child-exited-without-result，取消是 failed:exit_not_observed 且没有退出时间。
# 私有库、runner token、state-dir 与命令正文都留在 mktemp，不进日志。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-accept-fixes-2.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/accept2.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node --import tsx tests/fixtures/execution-accept-fixes-2.ts
pnpm exec vp test run tests/execution-accept-fixes-2.test.ts
printf 'PASS execution accept fixes 2: cancel replay channel checks, burst log honesty, exit evidence\n'
