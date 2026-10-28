#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Risk → Test
# 取消/超时把 runner 一起打死 → 执行确实停了，却报告「退出未被记录」 → 真实 SQLite + 真实
#   Worker outbox + 真实子进程：runner 是独立观察者，命令在自己的进程组里，信号只打命令组。
#   · 取消尊重 TERM 的命令 → result.json 落盘、取消 exited_observed、进程组清空。
#   · 取消忽略 TERM 的命令（含 `&` 起的后台子进程）→ KILL 命令组、后台子进程一起带走、
#     runner 活着落盘、取消仍然是 exited_observed。
#   · 运行上限到点且命令不响应 TERM → timed_out + failureReason='deadline'。
#   · 反证：runner 也死了（命令杀掉自己的观察者）→ 执行 unknown:child-exited-without-result，
#     取消 failed/exit_not_observed 且没有退出时间；未确认态没有被整体删掉。
# 私有库、runner token、state-dir 与命令正文都留在 mktemp，不进日志。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-exit-custody.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/exit-custody.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node --import tsx tests/fixtures/execution-exit-custody.ts
printf 'PASS execution exit custody: cancel and runtime limit keep the runner alive, exit_not_observed only when the runner is gone\n'
