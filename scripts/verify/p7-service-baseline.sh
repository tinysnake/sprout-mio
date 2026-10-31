#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# P7 F8：本地 HTTP 服务基线（列表/单对象/分页）与日志分页/积压测量。
# 样本只含本地 handler 与 SQLite，模型宿主显式关闭；数字写入 .verify，不设产品 SLA。
export NODE_ENV=production
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node scripts/verify/prepare.mjs server
node --import tsx scripts/p7/storage/measure-service.ts .verify/p7-service-baseline.json
