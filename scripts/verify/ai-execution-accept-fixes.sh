#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Risk → Test
# 非 holder 或交接后的旧 holder 仍能读执行与日志 → 真实 SQLite + 真实领域边界：
#   holder 正证、同 Project 非 holder 反证、交接后旧/新 holder 都拒、人类路径不受影响。
# 分身取消不核对调用方声明的授权代次 → 低/高两个不相等代次都报 lease_stale_generation，
#   取消行与诊断事件均不新增；相等时入队、幂等重放与同 id 换执行的冲突都断言。
# 小于单帧的 limitBytes 不前进 → 真实日志帧上 limitBytes=1 仍返回一帧并推进游标。
# 10 秒取消宽限被固定 15 秒确认窗口判成投递失败 → 窗口派生断言（10 秒 → 20 秒）与真实
#   忽略-TERM 终态在 ah-execution-live-e2e.sh（真实 Worker 进程）里验证，本脚本不重复真实进程。
# 私有库、runner token 与命令正文都留在 mktemp，不进日志。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-accept-fixes.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/accept.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/execution-accept-fixes.ts
pnpm exec vp test run tests/execution-accept-fixes.test.ts
printf 'PASS execution accept fixes: holder-only reads, cancel generation fence, soft log byte budget\n'
