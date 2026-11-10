#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/fixtures/webhook-live.mjs --assistant
pnpm exec tsx tests/fixtures/assistant-feedback.ts
pnpm exec vp test run tests/assistant-watch-summary-pi.test.ts
