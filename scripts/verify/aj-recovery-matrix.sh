#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# 真实服务 + 真实 Worker + 真实 SQLite 的 P0 12 格矩阵（4 故障 × 3 状态）。
# 门禁必须验证当前源码：产物存在也重建，避免旧 bundle 让门禁假绿。
export NODE_ENV=test
export SPROUT_PI_ENABLED=false
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
NODE_ENV=production pnpm build >/dev/null
NODE_ENV=production pnpm worker:build >/dev/null
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true
node --import tsx tests/fixtures/execution-recovery-matrix.ts
