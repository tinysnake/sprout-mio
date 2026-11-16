# Crew prompt A/B harness

Task definitions come exclusively from the fenced JSON in `docs/plans/crew-prompt-ab.md`.
The checked-out application uses the same production server, domain Crew fixture, machine
enrollment and Worker startup paths as the existing Pi live gates. Nothing under `src/` is changed.

Single arm:

```sh
AB_REF=origin/main AB_ARM=A AB_MODEL=provider/model \
  bash scripts/verify-live/crew-prompt-ab.sh
```

Alternating rounds (A tasks, B tasks, A tasks, B tasks):

```sh
AB_REF_A=baseline-ref AB_REF_B=prompt-ref AB_REPEAT=3 AB_MODEL=provider/model \
  bash scripts/verify-live/crew-prompt-ab-run.sh
```

The batch entry requires `AB_REF_A` and `AB_REF_B`. Both entry points accept:

| Variable | Meaning / default |
| --- | --- |
| `AB_MODEL` | Explicit Pi provider/model; falls back only to explicit `SPROUT_VERIFY_PI_MODEL` |
| `AB_TASKS` | Comma or whitespace separated task IDs; default all |
| `AB_REPEAT` | Positive number of rounds, default `1` |
| `AB_OUT` | Append-only JSONL, default `.verify/crew-prompt-ab.jsonl` |
| `AB_TASK_TIMEOUT_MS` | Per-task budget including its fixture and startup, default `600000` |
| `AB_DRY` | `1` selects the existing private local model-fixture endpoint |
| `AB_TASK_SOURCE` | Optional path to the original task document |

The model requirement is checked before producing artifacts, including in dry mode. Each ref
is resolved once and built in a temporary detached git worktree using `prepare.mjs` and
`ensure_worker_artifact`. A fresh database, Pi data directory, repository, machine state,
fixture and model-fixture are created for every task/repeat. Services listen on `0.0.0.0`;
the internal HTTP client and application origin share one hostname. All spawned service
and Worker processes are stopped before their result row is appended, and ref worktrees
are removed at the end. Evidence remains beside `AB_OUT`.

Rows distinguish `passed`, `failed`, `errored` and `timeout`. `passed` is null on errors and
timeouts; those observations are excluded from the success denominator. Any error or timeout
makes the batch exit nonzero while preserving previous rows. A measured oracle failure is
an experimental outcome and does not itself make the harness exit nonzero.

`wallClockPerPhase` records preparation of the task fixture, startup of the service and
Worker, sending the human task, waiting for settle, and judgement separately, in milliseconds.
`refPreparationMs` records the separate, once-per-ref checkout/install/build cost; it is not
charged repeatedly to task preparation. `totalMs` excludes shutdown; process records retain
shutdown exit codes and times. Waits use bounded probes for actual conditions, including
pending/bound/injected delegation deliveries, rather than fixed sleeps as completion evidence.

Delegation and run facts are read through existing domain functions in a small Node probe.
Worker run starts, statuses, complete receipts and blocked reasons come from the database.
Tool calls and provider token usage come from the persisted Pi transcripts referenced by DB
run snapshots. Transcript messages are attributed using persisted `sprout_turn_context.runId`,
so resumed runs within one database timestamp second do not double-count tokens. Missing
startup/transcript/usage evidence is an error, never invented zero usage. The fixture genuinely
reports zero tokens; live provider usage is recorded as returned. Strict lead-after-complete
ordering uses transcript millisecond timestamps and DB completion event timestamps.

The terminal prints per-task and per-arm tables for the current invocation. Its headline is
`inconclusive`: this harness does not invent a noise floor or promote a prompt automatically.
Three repeats of six tasks give 18 observations per arm, roughly ±11 percentage points standard
error; differences below 20 percentage points remain unresolved. Saturation at 0%/100% and
errors/timeouts are explicitly called out.

Run the harness regression test (real server/Worker, no paid provider):

```sh
node --test scripts/verify-live/crew-prompt-ab/harness.test.mjs
```

Or a standalone dry run:

```sh
AB_DRY=1 AB_REF=HEAD AB_MODEL=sprout-verify-local/chat-owner \
  AB_TASKS=donot-delegate-question \
  bash scripts/verify-live/crew-prompt-ab.sh
```

Dry mode scripts a local lead answer. It exercises transport, isolation, evidence, timing,
ledger and reporting; it does not measure delegation quality. Positive delegation tasks can
correctly produce `failed` in this mode because no delegation was performed. All six oracles
also have synthetic evidence tests, including early lead replies, missing completion receipts,
failed/aborted workers, duplicate dispatch and unchanged files.

`commands.jsonl` under the evidence directory lists each checkout/build/git subprocess with
its exact arguments, cwd, exit code, elapsed time and log. Each row's `childProcesses` lists
server, enrollment and Worker invocations and their actual shutdown status. Credentials stay
in private evidence directories and are never included in command records.
