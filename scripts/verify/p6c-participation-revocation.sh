#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p6c-participation-revocation.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
export DATABASE_URL="$verification_dir/participation-revocation.sqlite"
export NODE_ENV=test SPROUT_PI_ENABLED=false
log="$verification_dir/fixture.log"
# 一条明确没实现的断言不能靠退出 0 混过 runner：输出里出现 BLOCKED 就判失败。
node --import tsx tests/fixtures/p6c-participation-revocation.ts 2>&1 | tee "$log"
if grep -q "BLOCKED" "$log"; then
  echo "p6c-participation-revocation: fixture reported BLOCKED" >&2
  exit 1
fi
