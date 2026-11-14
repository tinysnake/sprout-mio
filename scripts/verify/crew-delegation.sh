#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# CR2 Crew delegation: real SQLite + production domain functions.
# Risk -> assertion (tests/delegation-core.test.ts, named behavioral cases)
# dispatch duplication -> same clientRequestId returns one delegation; child chat only.
# Crew timeline noise -> worker messages, results and prompts never appear as Crew messages.
# result delivery -> completed event becomes one lead prompt in the Crew run queue, ack is explicit.
# stale lead/epoch -> delivery is held for attention instead of waking the wrong lead.
# terminal events -> completed, blocked and canceled settle once; retry cannot re-settle.
# unauthorized worker -> completing another worker's delegation is forbidden.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/delegation-core.test.ts
