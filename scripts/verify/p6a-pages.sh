#!/usr/bin/env bash
# Component browser gate: frozen read fixtures, shared product components, real stylesheet.
set -euo pipefail
cd "$(dirname "$0")/../.."
node --import tsx tests/fixtures/p6a-pages-browser.ts
