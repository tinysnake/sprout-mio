#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# BD Task migration: isolated SQLite files, production migrateDatabase, no SQL mocks.
# Risk -> assertion (tests/task-migration.test.ts)
# Empty/0024 upgrade diverges -> migrate from zero; populated 0024 preserves messages/run FK/input, new fields NULL.
# Repeat migration corrupts data -> journal and rows unchanged on second migrateDatabase.
# Missing triggers -> sqlite_master contains all required Task and existing P5a triggers.
# Four-state shape bypass -> task CHECK tested independently of insert guard, all legal/illegal Chat combinations.
# Raw SQL circumvents lifecycle/CAS/result -> invalid edges/revisions/last-start completion rejected.
# Mutable result/history -> UPDATE/DELETE records/events and detach/promote ordinary message rejected.
# Scope/author/FK escape -> inactive or spoofed Agent, old Chat, cross-Chat reference, Task assistant rejected.
# Checklist instability -> append max+1, no reorder/reuse/hard delete/undelete.
# Admission escape -> ordinary/progress cannot admit; start admits once, ACK still succeeds.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/task-migration.test.ts
