# Round 2 harness fix verification — 2026-11-16

Started from fetched `origin/t3/5b6c57cd` at `5c60c8c`. This round closes review items
A–H: live/dry prompt-length separation plus live batch dry hash preflight, delegation-to-artifact
attribution, queue/tool and installation/tool evidence, forbidden-delegation denominator handling,
worker-tool duplicate detection, precise timeout/cleanup/completed-run evidence handling, and
fixture-owned Node-line/retry-value assertions. Application code under `src/` is unchanged.

| Check                                                                                        | Actual exit code | Result                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Initial harness test run while implementing                                                  | 1                | New regressions exposed missing-snapshot handling and a fixture reporting-tool path; corrected before final verification |
| Attribution mutation: worker tool argument changed from `utils/format.js` to `unrelated.txt` | 1                | The otherwise passing attribution fixture fails with `false !== true`; transcript mutation restored                      |
| Restored full harness suite: `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs`     | 0                | 19 passed, 0 failed                                                                                                      |
| Dry alternating batch, 2 repeats × 6 tasks × 2 arms                                          | 0                | All 24 planned/attempted/completed; 4 passed, 20 measured failures; no anomalies; comparison eligible                    |
| Dry batch interrupted with SIGTERM after its first measured row                              | 143              | 1 failed, 1 interrupted, 22 not_run; all 24 ledger rows retained; comparison refused                                     |
| Ledger audit of ordering, outcomes, ready evidence, hashes and anomaly denominators          | 0                | A/B order in repeat 1, B/A in repeat 2; every completed dry run has startup, transcript, tokens and observed hash        |
| Scoped formatter, formatter check, lint, module syntax checks, `git diff --check`            | 0                | Passed                                                                                                                   |
| Initial direct `pnpm exec oxfmt` attempt                                                     | 254              | CLI is not directly exposed; switched to repository-supported `pnpm exec vp fmt`, exit 0                                 |

Dry batch command (both refs fetched and pinned by the harness):

```sh
AB_DRY=1 AB_MODEL=local-fixture AB_REPEAT=2 \
  AB_REF_A=277f506c15fe771bbd337efa259dc517c3ffc1cd \
  AB_REF_B=3c0f25c75f77689bfbf79349149cbe2abae6d1a7 \
  AB_OUT=/tmp/crew-ab-round2/alternating.jsonl \
  bash scripts/verify-live/crew-prompt-ab-run.sh
```

The interrupted invocation used the same settings and a separate ledger. The subprocess driver
sent SIGTERM when stdout first contained a `PASSED` or `FAILED` row. Each arm retains 12 planned
items; A has one measured failure, B one interrupted item, with 11 not_run each. All unmeasured
rows retain `passed: null`.

The dry model only answers the glossary question. The seeded correct installation document no
longer passes without a tool naming `docs/usage.md`, accounting for four additional failures
relative to round 1. Per-task/role prompt length sets are disjoint: A lead lengths 689–698,
B lead lengths 1523–1532. These checks validate transport and evidence, not live delegation quality.
No paid live model batch was run. Missing/equal live-preflight hash refusal is covered by regression
tests; the batch entry runs its two local probes before starting any live measurement item.

The attribution mutation changed only the synthetic worker transcript's default tool path;
request text, completion receipt and successful artifact assertion remained unchanged. The focused
test failed (exit 1); after restoration the whole suite passed (exit 0). Permanent regressions also
cover a lead doing the work while delegating a decoy, mismatched child chats, a finding with no
queue tool call, pathless duplicate requests detected through worker bash calls, forbidden
workers timing out/aborting, fixture close errors preserving passed/failed, incomplete completed-run
evidence, shared prompt lengths across repeats on both paths, stray README `18` text, and missing
or incorrect retry values.

Local evidence: `/tmp/crew-ab-round2/` (`tests-green.log`, `attribution-red.log`, their `.exit`
files, alternating/interrupted logs and ledgers, `ledger-audit.json`, format/lint output and private
per-invocation evidence). Driver: `/tmp/crew-ab-round2-driver.mjs`. Private credentials/transcripts
are not committed. Earlier round's evidence below is retained as historical context.

# Round 1 harness fix verification — 2026-11-16

This verifies transport, artifact oracles, ledger accounting and comparison guards in AB_DRY.
It does not measure live model delegation quality. Task definitions and oracle names remain in
`docs/plans/crew-prompt-ab.md`.

| Check                                                       | Actual exit code | Result                                                                                              |
| ----------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| Harness tests, restored implementation                      | 0                | 12 passed, 0 failed                                                                                 |
| Dry alternating batch, 2 repeats × 6 tasks × 2 arms         | 0                | 24 planned/attempted/completed; 8 passed, 16 measured failures; no anomalies                        |
| Dry batch interrupted with SIGTERM                          | 143              | 24 ledger rows: 1 measured failure, 1 interrupted, 22 not_run; comparison refused; rates suppressed |
| Same-SHA batch startup guard                                | 1                | Refused before building or starting tasks; 2 not_run rows                                           |
| Temporarily revert artifact-result gate, run harness tests  | 1                | Regression caught: 11 passed, 1 failed (`true !== false`)                                           |
| Restore artifact-result gate, run harness tests             | 0                | 12 passed, 0 failed                                                                                 |
| Scoped formatting check, syntax checks and git diff --check | 0                | Passed                                                                                              |

Two application refs were fetched and pinned:

- A: `277f506c15fe771bbd337efa259dc517c3ffc1cd` (parent of the role-aware prompt change).
- B: `3c0f25c75f77689bfbf79349149cbe2abae6d1a7` (role-aware crew lead / worker prompts).

The alternating command was:

```sh
AB_DRY=1 AB_MODEL=local-fixture AB_REPEAT=2 \
  AB_REF_A=277f506c15fe771bbd337efa259dc517c3ffc1cd \
  AB_REF_B=3c0f25c75f77689bfbf79349149cbe2abae6d1a7 \
  AB_OUT=/tmp/crew-ab-fix-final/alternating.jsonl \
  bash scripts/verify-live/crew-prompt-ab-run.sh
```

The ledger order is A/B for every task in repeat 1, B/A in repeat 2. Each arm records
12 planned, 12 attempted and 12 completed items: 4 passed and 8 failed. The scripted lead
answers the glossary question and leaves the already correct install steps intact, so those
oracles pass. The three delegation tasks and timeout edit fail because the dry lead neither
delegates nor edits artifacts. The unfixed rounding fixture independently records both
`project-test` (`npm test`) exit 1 and the direct `rounding` assertion exit 1, in its fixture
worktree. No worker completion claim can override those exits.

Every completed run has ready prompt length, ready tool names, observed system prompt hash
bound to its `runId`, and `inheritHostResources: false`. Lead prompt lengths were 699 for A
and 1533 for B, with 55 available tools in both arms. The observed hashes differ. The summary
prints `Comparison eligible; descriptive results only.` and remains `inconclusive` about
model quality or causal performance.

The interrupted batch used the same configuration. A subprocess driver watched stdout for
the first `PASSED`/`FAILED` row, then sent SIGTERM to the harness process. The first A task
completed as a measured failure; the next B task was interrupted. Both arms retain all
12 planned rows: A attempted/completed 1/1 with 11 not_run; B attempted/completed 1/0 with
1 interrupted and 11 not_run. All unmeasured rows have `passed: null`. The summary prints:

```text
Comparison refused: incomplete batch: anomalous or not_run items; missing matching role delegate-one-fix/lead
```

For the mutation check, the implementation's `if (!artifactsPass) return false;` gate was
temporarily bypassed, then the same harness tests were executed. Captured red output:

```text
✖ claims and complete receipts cannot substitute for artifact commands
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
true !== false
```

The gate was restored and the full 12-test suite passed. The mutation is not present in the
committed implementation. Tests also cover the planted artifacts, canceled/timed-out/aborted
worker runs, duplicate assignments to different workers (including directory resources),
latest lead final replies, identical prompt hashes, missing ready evidence, differing tool
sets by role, and anomaly denominator accounting.

Full local evidence remains at `/tmp/crew-ab-fix-final/`:

- `tests-green.log` / `tests-green.exit`
- `assertion-reverted-red.log` / `assertion-reverted-red.exit`
- `alternating.log`, `alternating.jsonl`, `alternating.exit`
- `interrupted.log`, `interrupted.jsonl`, `interrupted.exit`, `interrupted-signal.json`
- `same-ref.log`, `same-ref.jsonl`, `same-ref.exit`
- Per-invocation directories containing `plan.json`, `refs.json`, `summary.json`, command logs,
  per-task result JSON, domain evidence, transcripts and per-run prompt hash files.

The interruption driver is `/tmp/crew-ab-fix-final/interrupt-driver.mjs`. Temporary ref
worktrees and server/Worker processes were cleaned up by the harness. Evidence directories
contain private fixture credentials and are not committed.
