#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .verify
exec pnpm exec vp test run tests/run-attention-domain.test.ts tests/run-attention-integration.test.ts tests/pi-host-liveness.test.ts tests/run-attention-ui.test.ts
