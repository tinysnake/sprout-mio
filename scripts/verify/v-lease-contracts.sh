#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-lease-contracts.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/contracts.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/lease-contracts.ts
node --import tsx src/db/migrate.ts
pnpm exec vp test run tests/lease-contracts.test.ts
printf 'PASS lease contracts isolated migrations, SQL constraints and wire schemas\n'
