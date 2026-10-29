#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/ensure-worker-artifact.sh"
node scripts/verify/prepare.mjs server
ensure_worker_artifact
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/worker-remote-live.ts
node --import tsx tests/fixtures/lease-force-live.ts
