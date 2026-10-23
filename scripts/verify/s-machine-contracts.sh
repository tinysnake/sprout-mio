#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-machine-contracts.XXXXXX")"
export DATABASE_URL="$verification_dir/contracts.sqlite"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
node --import tsx tests/fixtures/machine-contracts.ts all
node --import tsx src/db/migrate.ts
pnpm exec vp test run tests/machine-contracts.test.ts
printf 'PASS machine contracts isolated migration and constraints %s\n' "$verification_dir"
