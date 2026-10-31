#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p6c-participation-revocation.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/participation-revocation.sqlite"
export NODE_ENV=test SPROUT_PI_ENABLED=false
node --import tsx tests/fixtures/p6c-participation-revocation.ts
