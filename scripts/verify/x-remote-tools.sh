#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Risk → Test
# Wrong/implicit target or model-supplied identity → every frozen tool schema + rejected calls.
# Wrong HTTP success/error handling → actual HTTP domain denial, timeout, abort, redirect, bounds.
# Host tool regression → sprout_status and sprout-status unchanged observable result.
# Runner failed to register/load/inject → installed SDK, real runner and a controlled HTTP endpoint.
# Production grant/lease authorization and real Worker effects remain worker/integration gates.
# Run grant cleanup → real child abort/close/exit and late disposer registration.
pnpm exec vp test run tests/remote-tools.test.ts tests/pi-host-dispose.test.ts
node --import tsx tests/fixtures/remote-tools-runner.mjs
