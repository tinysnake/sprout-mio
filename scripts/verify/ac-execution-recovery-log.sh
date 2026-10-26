#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 真实 SQLite + 真实服务端边界：恢复归约、日志游标与 gap、取消六态、反证。
# 私有库、runner token 与命令正文都留在 mktemp，不进日志。
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-recovery.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/recovery.sqlite"
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/execution-recovery.ts
printf 'PASS execution recovery reduction, log cursor/gap and cancellation states on real SQLite\n'
