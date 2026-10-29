#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 真实服务 + 真实 Worker + 真实 SQLite 的 P0 12 格矩阵（4 故障 × 3 状态）。
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
NODE_ENV=production node scripts/verify/prepare.mjs server >/dev/null
NODE_ENV=production node scripts/verify/prepare.mjs worker >/dev/null
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node --import tsx tests/fixtures/execution-recovery-matrix.ts
