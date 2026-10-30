#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# BA Task domain: real SQLite + production domain functions, using group-chat fixture conventions.
# Risk -> assertion (tests/task-domain.test.ts, named behavioral cases)
# §2.1/2.2/2.7 four-state/CAS/result drift -> lifecycle, immutable result history and event seq boundaries.
# §2.3/2.5 @ fanout or accidental execution -> explicit-start DM/Group recipient, Human/channel zero run/input.
# §2.6 responsibility confusion -> DM Agent vs Human owner; current Group owner; channel Project Human.
# §2.8/2.9 stale start delivery -> admission idempotence, generation cancellation, governance revocation.
# §2.10 cross-Chat/project leaks -> real Agent run scopes, redacted old records, forbidden references.
# §11 races -> two independent Node processes append/complete with identical expectedRevision; one CAS wins.
# §11 partial transactions -> failed correction and oversized snapshot leave no message/event/revision changes.
# Nonmember/nonowner -> forbidden/not_found before stale revision, revoked DM assignment rejected.
# Direct SQL immutability/author/event/CHECK/admission bypass -> migration counterexamples execute in this gate too.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/task-domain.test.ts tests/task-migration.test.ts
