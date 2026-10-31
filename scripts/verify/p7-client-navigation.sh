#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm exec vp test run tests/verify-p7-client.test.ts
node scripts/browser/p7-client-navigation.mjs navigation
