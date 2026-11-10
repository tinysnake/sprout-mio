#!/usr/bin/env bash
set -euo pipefail
trap 'printf "FAIL MCP Worker verification line=%s\n" "$LINENO" >&2' ERR
cd "$(dirname "$0")/../.."
# 这条门禁需要宿主已安装的托管 Pi SDK（bin/pi 或 install/releases 任一形态）。先决条件不在时
# 打印 SKIP 并退出 77，runner 会记为 skipped：不计失败，也不产生通过结论。
node scripts/verify/lib/host-pi-sdk.mjs y-mcp-worker || exit $?
mkdir -p .verify
verification_dir="$(mktemp -d .verify/y-mcp-worker-XXXXXX)"
export DATABASE_URL="$PWD/$verification_dir/private.sqlite"
export SPROUT_PI_ENABLED=false
export MCP_EVIDENCE="$PWD/$verification_dir/evidence.json"
pnpm exec vp test run tests/mcp-worker.test.ts tests/mcp-worker-domain.test.ts tests/mcp-worker-evidence.test.ts
printf 'PASS MCP Worker targeted tests\n'
MCP_EVERYTHING=1 node --import tsx tests/fixtures/mcp-worker-live.ts
printf 'PASS MCP real process evidence %s/evidence.json\n' "$verification_dir"
