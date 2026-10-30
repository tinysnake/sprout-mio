#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# BE Task Info Hub: real SQLite + production Project/Chat aggregation entry points.
# Risk -> assertion (tests/task-info-hub.test.ts)
# Task status/record writes infer run or lease state -> compare every raw run/lease field and hub views.
# Run completion/failure infers Task progress -> compare raw Task and all non-context summary fields.
# Lease release infers Task/run progress -> unchanged Task, run and Chat views after real lease mutation.
# Wrong Chat counts/context or leaked bodies -> four states, exact assigned ids, stable sort, strict schemas,
#   record/checklist metadata, current Human/Agent responsibility and explicit injectedIntoPrompt=false.
# Cross-Project/Chat or revoked Agent access -> real run identity, summary allowed, detail denied.
# N+1 Task queries -> listen to SQLite prepare; Project/Chat statement counts unchanged with 40 more Tasks.
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
pnpm exec vp test run tests/task-info-hub.test.ts
