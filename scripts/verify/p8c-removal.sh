#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/sprout-p8c-removal.XXXXXX")"
trap 'rm -rf "$verification_dir"' EXIT
# setup() 固定插入 user 'p6c-human'，同进程只能跑一个 scenario，因此每个 scenario 一个库。
for scenario in normal retained fencing isolation; do
  export DATABASE_URL="$verification_dir/p8c-removal-$scenario.sqlite"
  export NODE_ENV=test SPROUT_PI_ENABLED=false
  node --import tsx tests/fixtures/p8c-forced-removal.ts "$scenario"
done
printf 'PASS p8c forced removal\n'
