#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# 这门禁需要宿主已安装的托管 Pi SDK（bin/pi 或 install/releases 任一形态）。先决条件不在时
# 打印 SKIP 并退出 77，runner 会记为 skipped：不计失败，也不产生通过结论。
node scripts/verify/lib/host-pi-sdk.mjs x-remote-tools || exit $?

# Risk → Test
# Wrong/implicit target or model-supplied identity → every frozen tool schema + rejected calls.
# Wrong HTTP success/error handling → actual HTTP domain denial, timeout, abort, redirect, bounds.
# Host tool regression → sprout_status and sprout-status unchanged observable result.
# Runner failed to register/load/inject → installed SDK, real runner and a controlled HTTP endpoint.
# Production grant/lease authorization and real Worker effects remain worker/integration gates.
# Run grant cleanup → real child abort/close/exit and late disposer registration.
pnpm exec vp test run tests/remote-tools.test.ts tests/pi-host-dispose.test.ts
node --import tsx tests/fixtures/remote-tools-runner.mjs
