#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-execution-log-contracts.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/contracts.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx src/db/migrate.ts
pnpm exec vp test run tests/execution-log-contracts.test.ts
printf 'PASS execution log and cancellation contracts isolated migration, SQL constraints and wire schemas\n'
