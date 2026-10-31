#!/usr/bin/env bash
# Shared UI facts + real stylesheet + CDP. Production refresh wiring is integration-owned.
set -euo pipefail
cd "$(dirname "$0")/../.."
node --import tsx tests/fixtures/p6b-pages.ts
