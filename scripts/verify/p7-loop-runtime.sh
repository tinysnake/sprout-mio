#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export SPROUT_VERIFY_CHAT_MODE=model-fixture
export SPROUT_PI_ENABLED=false
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
mkdir -p .verify
export SPROUT_P7_LOOP_EVIDENCE_DIR="$(mktemp -d "$PWD/.verify/p7-loop-runtime-XXXXXXXX")"
evidence="$SPROUT_P7_LOOP_EVIDENCE_DIR"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/exit-code"; printf "EVIDENCE %s exit=%s\n" "$evidence" "$code"' EXIT
git rev-parse HEAD > "$evidence/base-commit"
{ git ls-files -z src drizzle package.json pnpm-lock.yaml | xargs -0 shasum -a 256
  shasum -a 256 tests/fixtures/p7-loop-*.ts scripts/verify/p7-loop-*.sh scripts/verify/lib/model-fixture.mjs
} > "$evidence/source-sha256.txt"
export DATABASE_URL="$evidence/private.sqlite"
export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
node --import tsx tests/fixtures/p7-loop-domain.ts runtime
