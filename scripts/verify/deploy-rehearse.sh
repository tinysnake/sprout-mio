#!/usr/bin/env bash
# 部署演练：本地裸远端 + 临时运行根目录，跑首次部署、升级、回滚。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
exec bash scripts/deploy/rehearse.sh
