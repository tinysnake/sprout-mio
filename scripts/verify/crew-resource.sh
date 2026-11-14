#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# CR3 Crew resource coordination: real SQLite + production domain functions.
# Risk -> assertion (tests/crew-resource.test.ts, named behavioral cases)
# grant leaks across runs -> only the bound run/attempt/epoch scope can execute.
# queue jump -> approval alone grants nothing; one Project x Machine slot, FIFO.
# silent lease theft -> lead takeover freezes the source and waits for drain; target gets a new generation.
# offline takeover -> unconfirmed drain stays fencing/attention and never issues a second writable grant.
# stale generation -> old authorization cannot write after takeover or force reclaim.
# worker bypass -> delegation chats cannot call legacy lease mutations.
# human control -> force reclaim stays a Human action and a Crew grant cannot block cancellation.
# release without drain -> completion/reclaim keeps the slot until terminal state is confirmed.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/crew-resource.test.ts tests/p8b-lease-wait.test.ts
