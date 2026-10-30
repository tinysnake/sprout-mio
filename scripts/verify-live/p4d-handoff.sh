#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# I-P4d 真实交接：先跑不依赖模型的真实 Worker 路径，再用真实 Pi 模型跑一次
# 「模型自己 acquire → 派发长命令 → handoff」。真实凭证缺失时明确 SKIP 并以
# 非零退出，不把缺模型当 PASS；模型无关的门禁见 scripts/verify/ap-p4d-handoff-worker.sh。
source "$(dirname "${BASH_SOURCE[0]}")/../verify/lib/ensure-worker-artifact.sh"
node scripts/verify/prepare.mjs server
ensure_worker_artifact
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
export SPROUT_VERIFY_PI_MODEL="${SPROUT_VERIFY_PI_MODEL:-magpie/auto/deepseek-v4.1-flash}"

node --import tsx tests/fixtures/p4d-handoff-worker.ts

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ ! -f "$agent_dir/auth.json" ]; then
  printf 'SKIPPED real Pi credentials missing (%s/auth.json); live model handoff is not PASS\n' "$agent_dir" >&2
  exit 2
fi
node --import tsx tests/fixtures/p4d-handoff-model.ts
printf 'PASS LIVE p4d handoff: real Worker (handoff/revoke/removal keep the process and files) and real model handoff (%s)\n' "$SPROUT_VERIFY_PI_MODEL"
