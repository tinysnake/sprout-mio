#!/usr/bin/env bash
# 部署脚本自检：在临时运行根目录里跑完整链路，不碰真实实例。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
exec bash scripts/deploy/selftest.sh
