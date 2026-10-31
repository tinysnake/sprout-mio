#!/usr/bin/env bash
# Shared UI facts + real stylesheet + CDP, then the real production pages that consume them.
# The first harness renders the shared components against frozen read fixtures (fast, per-width);
# the second builds the real production server and asserts the wiring: one polling owner per page,
# the 3s/hidden/resume timing, the runId-keyed turn block, and the run facts that must stay put.
set -euo pipefail
cd "$(dirname "$0")/../.."
node --import tsx tests/fixtures/p6b-pages.ts
node scripts/verify/p6b-wiring-pages.mjs
