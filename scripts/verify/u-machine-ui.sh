#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/ensure-worker-artifact.sh"
ensure_worker_artifact
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
node scripts/browser/p4a-machine-flow.mjs
