#!/usr/bin/env bash
set -euo pipefail
trap 'printf "FAIL MCP HTTP Worker verification line=%s\n" "$LINENO" >&2' ERR
cd "$(dirname "$0")/../.."
mkdir -p .verify
verification_dir="$(mktemp -d .verify/y2-mcp-http-worker-XXXXXX)"
export DATABASE_URL="$PWD/$verification_dir/private.sqlite"
export SPROUT_PI_ENABLED=false
export MCP_EVIDENCE="$PWD/$verification_dir/evidence.json"
pnpm worker:build
node --import tsx tests/fixtures/mcp-http-worker-live.ts
printf 'PASS MCP HTTP Worker evidence %s/evidence.json\n' "$verification_dir"
