#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# P7 存储：整体迁移、在线一致备份、全新目录恢复、升级/重启恢复边界与诊断关联链。
# 备份实现与反证在 scripts/p7/storage/snapshot.ts 与 tests/storage-snapshot.test.ts；
# 这里走真实生产构建、真实迁移和真实 server 进程，不复制主库文件冒充备份。
export NODE_ENV=production
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node scripts/verify/prepare.mjs server
node --import tsx scripts/p7/storage/verify-recovery.ts
