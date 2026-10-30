#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# BC Task start: real SQLite, domain, runtime grants and HTTP gateway; no model run.
# Risk -> assertion (behavioral cases in the two test files)
# §6.1 wrong recipients/@ fanout -> DM/Agent Group/Human Group/Public Channel x
#   startNow off/on asserts exact run/message/input/notice deltas and recipient identity.
# DM/Public Channel have frozen ownership; the four rows are the valid responsibility
#   combinations, rather than manufacturing unsupported Agent-owned channels/DMs.
# mention_only silently loses explicit start -> owner input exists, repeated start reuses run.
# §6.2 cascade/bare-name loophole -> only owner + explicit @ wakes a member; bare names,
#   suffixed names, member @owner and nonowner sends create no inputs; ChatActor matches run.
# Human P5a drift -> mention_only/owner_led and bare-name routing remain unchanged.
# §6.3 stale Task/owner -> complete/cancel/reassign/governance cancels unattempted start,
#   selects the next ordinary input, and admit never calls transport for the obsolete row.
# §6.4 repeat send before/after ACK -> admittedAt is persisted before synchronous send;
#   no ACK, synchronous throw and async rejection cannot re-admit; ACK keeps admittedAt.
# normal handoff -> valid unattempted Task + ordinary pending move; attempted Task stays
#   on old run with a diagnostic; failed/interrupted/Human stop never create replacement run.
# §8.3 identity/scope escalation -> all 11 tools reject identity/project/chat fields;
#   real grant confines task_list/get and chat_get/send; member mutations return forbidden.
# wire forgery -> gateway rejects unsupported actions/identities; client rejects extra
#   response fields, wrong Task/Project/Chat bindings and Human-sender chat_send responses.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/task-start.test.ts tests/task-agent-tools.test.ts
