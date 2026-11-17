# cal1 lead metrics: offline diagnosis

Scope: `worker-takes-minutes`, one A/B pair from `/tmp/crew-ab-cal1/ledger.jsonl`,
base `65439ec`, branch `t3/crew-ab-metrics`. No live run was started. Frozen arms
and the registered definitions in `docs/plans/crew-prompt-ab.md` were not edited.

## Extraction and gate semantics

- ISO timestamps and numeric millisecond timestamps share one parser. Lead wall
  time is the sum of individual lead run spans, including waiting within a run;
  it excludes gaps between runs. Worker spans use each real worker run's timestamps.
- Session files are read once and assistant messages are partitioned by persisted
  `sprout_turn_context.runId`. Two lead runs referencing one session do not charge
  the same calls twice or include earlier unrelated turns.
- A recorded tool call is an observed attempt, even when its name is absent from
  the advertised tool surface. A's rejected `given` attempt previously poisoned
  the entire lead call list, hiding two explicit sleeps totalling 230000ms.
- `unmappedArtifacts` keeps the existing definition: unique successful explicit
  write/edit paths not named by delegation requests. It does not claim to enumerate
  arbitrary shell side effects; opaque nested writes or sleeps remain unknown.
- The registered `verdict` retains `leadBudget` with its original wall-time limit,
  now measured correctly. `verdictCorrected` replaces that check with
  `leadActionBudget`: explicit lead `sprout_delegation_list` calls after dispatch
  and before the first completion receipt <=1, and total lead `sleep.ms` <=500ms.
  `sleepObserved` and `noRepeatedQueries` expose those component results. Nested
  codemode queries are not counted as explicit list calls.
- Missing measurements produce `null` checks and reasons in `actual`, not false
  or NaN. A known violation still establishes failure; otherwise an unknown gate
  yields `passed:null`, `evaluated:false`, `outcome:"unmeasured"` and comparison
  refusal. Long-worker evidence passes if any measured worker span is >=180000ms;
  it remains unknown if no measured span reaches the threshold and some clocks
  are missing.
- Offline rejudge now rebuilds metrics and run observations from the saved domain
  snapshot and transcripts, recording SHA-256 evidence paths once per transcript.
  It preserves the input objects, original ledger, artifact assertion results and
  recorded commands. It does not execute recorded commands.

## Risk -> regression

| Risk | Protection in metrics-regression.test.mjs |
| --- | --- |
| Rejected unknown-tool attempt invalidates all metrics, or a shared session is double counted | Bound multi-run session includes unrelated history, failed tool and explicit sleeps; assert calls, sleep, write mapping and wall sums |
| ISO spans become NaN, or wall waiting rejects efficient lead behavior | 263000/224000/234000ms worker cases, original wall budget vs corrected action budget |
| Missing evidence becomes a measured failure | Null checks, reasons, unmeasured outcome/comparison refusal, known violation dominates unknown |
| Queries outside the waiting interval count, or missing query timing fabricates zero | Before-dispatch and after-receipt calls excluded in corrected view; unknown timestamps/transcript remain null |
| Offline rejudge trusts stale ledger metrics | Rebuild from real temporary JSONL/domain files, audit shared transcript once, input unchanged |

The old test expecting missing sleep evidence to fail was removed; the missing
measurement regression above replaces it with the required unknown semantics.

## Recorded results

Output: `/tmp/crew-ab-cal1/diagnosed-metrics.jsonl`.
Summary: `/tmp/crew-ab-cal1/diagnosed-metrics-summary.json`.

| Reading | A | B |
| --- | ---: | ---: |
| leadMs / leadWallMs | 349000ms | 38000ms |
| lead tool calls | 57 | 8 |
| worker tool calls | 42 | 11 |
| sleepMsTotal | 230000ms | 0ms |
| explicit waiting queries | 2 | 0 |
| unmappedArtifacts | 0 | 0 |
| individual worker spans, chronological | 263000ms, 224000ms | 234000ms |
| workerWallMs (sum) | 487000ms | 234000ms |
| genuinelyLongWorker | true | true |
| corrected leadActionBudget | false | true |
| delegatedDelivery count (expected 1) | false (2) | true (1) |
| verdict / verdictCorrected | false / false | true / true |

`comparisonReasons` verbatim: `[]`. Evidence warnings: `[]` for both rows.
A fails `delegatedDelivery` and `eventDrivenWait`; B fails no gates.
Both verdict views read A 0/1 vs B 1/1. This item now distinguishes the observed
behaviors. One pair is descriptive evidence only: a two-sided exact paired test
with one discordant pair has p=1; it cannot establish population superiority or
justify promotion.

## Verification evidence

First red run, before implementation (`/tmp/crew-ab-cal1/metrics-red.log`):

```text
ℹ tests 4
ℹ pass 0
ℹ fail 4
ℹ duration_ms 108.082875
```

Exit 1. Expected failures: `null !== 4`, `NaN !== 349000`, `false !== null`,
and offline rejudge retaining `null !== 4`.

Initial green regression run (`/tmp/crew-ab-cal1/metrics-green.log`):

```text
ℹ tests 4
ℹ pass 4
ℹ fail 0
ℹ duration_ms 102.528834
```

Exit 0. A fifth query-boundary regression was subsequently added. Final command:
`node --test scripts/verify-live/crew-prompt-ab/*.test.mjs` (exit 0).

```text
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2911.261209
```

`git diff --check`: exit 0, empty output. Logs: `metrics-suite.log` and
`metrics-diff-check.log` under `/tmp/crew-ab-cal1/`. SHA-256 checks confirm the
source ledger and every audited domain/transcript file match the hashes saved by
rejudge. The output rows also match the final implementation when recomputed in
memory; no second output file or live run was needed.
