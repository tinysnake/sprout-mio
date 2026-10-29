#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 真实 macOS Worker + 真实服务 + 真实 SQLite + 真实 agent 工具面。
# 私有库、ticket、cookie、命令正文与日志正文都留在 .verify 下的临时目录，不进输出。
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
node --input-type=module -e 'import { selectAhGroups } from "./scripts/verify/lib/ah-manifest.mjs"; selectAhGroups(process.argv.slice(1));' -- "$@"
NODE_ENV=production node scripts/verify/prepare.mjs server >/dev/null
NODE_ENV=production node scripts/verify/prepare.mjs worker >/dev/null
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node scripts/verify/ah-groups.mjs "$@"
printf 'PASS execution live e2e (execution id ↔ process, dedupe, cursor, disconnect, cancels, restarts)\n'
