#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P4d 真实 Worker 交接门禁（不依赖真实模型）：
# 真实生产服务 + 真实 macOS Worker + 真实 SQLite + 真实 Agent HTTP 边界。
# 覆盖：交接后新 holder 读到同一执行与既有日志、跨交接周期写文件连续、
# 撤销授权与移出 Project 不杀执行、对在途执行的显式取消真实结果。
source "$(dirname "${BASH_SOURCE[0]}")/lib/ensure-worker-artifact.sh"
node scripts/verify/prepare.mjs server
ensure_worker_artifact
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/p4d-handoff-worker.ts
