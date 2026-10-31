#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
verification_dir="${SPROUT_VERIFY_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/sprout-p6a-routing.XXXXXX")}"
mkdir -p "$verification_dir"
export DATABASE_URL="$verification_dir/routing.sqlite"
export SPROUT_PI_ENABLED=false
node --import tsx --input-type=module -e 'await import("./src/domain/wake-evaluation.ts"); console.log("PASS direct evaluator import: 1 assertion (fresh module graph)")'
node --import tsx src/db/migrate.ts
node --import tsx tests/fixtures/p6a-routing.ts
