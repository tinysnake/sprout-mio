#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "${SPROUT_VERIFY_DRAIN_SKIP_BUILD:-0}" != "1" ]]; then
  rm -rf .output
  pnpm build
fi
node scripts/verify/drain-http.mjs
