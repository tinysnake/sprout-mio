# Crew prompt A/B harness

Task definitions and oracle names come exclusively from the fenced JSON in
`docs/plans/crew-prompt-ab.md`. The harness builds each application ref in a temporary detached
worktree, then exercises its production server, domain Crew fixture, machine enrollment and
Worker paths. It does not modify application code under `src/`.

Single arm:

```sh
AB_REF=origin/main AB_ARM=A AB_MODEL=provider/model \
  bash scripts/verify-live/crew-prompt-ab.sh
```

Alternating batch (each task runs A/B in odd repeats, B/A in even repeats):

```sh
AB_REF_A=baseline-ref AB_REF_B=prompt-ref AB_REPEAT=3 AB_MODEL=provider/model \
  bash scripts/verify-live/crew-prompt-ab-run.sh
```

| Variable | Meaning / default |
| --- | --- |
| `AB_MODEL` | Explicit Pi provider/model; falls back only to explicit `SPROUT_VERIFY_PI_MODEL` |
| `AB_TASKS` | Comma or whitespace separated IDs from the task document; default all |
| `AB_REPEAT` | Positive number of repeats, default `1` |
| `AB_OUT` | Append-only JSONL, default `.verify/crew-prompt-ab.jsonl` |
| `AB_TASK_TIMEOUT_MS` | Per-task budget including fixture and startup, default `600000` |
| `AB_DRY` | `1` uses the private local model fixture; still requires explicit `AB_MODEL` |
| `AB_TASK_SOURCE` | Optional path to the original task document |

Both refs are fetched before resolution and pinned to full commit SHAs before either build.
Branch refs resolve from their fetch result; object refs and `HEAD` resolve after fetching origin.
The batch refuses to start if both arms resolve to the same commit, including different aliases
for that commit. `refs.json` and every ledger row record the resolved `head`; `ref` and
`testedRef` retain the requested ref.

Before preparation, `plan.json` enumerates every arm/task/repeat. Every planned item receives
exactly one ledger row. SIGINT/SIGTERM abort active work, clean up child processes and worktrees,
and append `not_run` rows for all items that never started, including interruption during builds.
Rows completed before interruption remain measured. The summary reports `planned`, `attempted`,
`completed`, `passed`, `failed`, `errored`, `timeout`, `aborted`, `interrupted`, and `not_run` for
each task/arm and each arm total. Only `passed` and `failed` enter success denominators;
`passed` is null for every anomaly. For `no_delegation` and `no_delegation_but_work_done`,
any observed delegation is already a measured failure, including when its worker later hangs,
aborts or errors. Other aborted runs cannot pass an oracle. Incomplete batches
refuse comparison and suppress success rates. SIGINT exits 130 and SIGTERM exits 143; setup,
execution and comparison errors exit 1. Measured oracle failures alone do not change exit status.
A single-arm invocation reports observations without a comparison.

Every task/repeat has a fresh DB, Pi data directory, fixture git repository, machine state and
model fixture. The project's bound workDirectory is that fixture worktree; the enrolled machine's
project path links to the same worktree, so native tools and machine tools inspect the same files.
Services bind `0.0.0.0` and use one LAN hostname for origin and HTTP clients.
`SPROUT_PI_INHERIT_HOST_RESOURCES=0` disables host skill and prompt template inheritance in both
dry and live runs; the comparison checks the ready snapshot confirms it.

All expected artifact values come from `fixtures.mjs`, which owns the fixture builder, its planted
inputs and expected results. No oracle treats a worker summary as proof that a file was fixed.
`artifactAssertions` records each assertion's `name`, exact `command` array, fixture `cwd`,
`exitCode`, `signal`, `elapsedMs`, `stdout` and `stderr`. A signal or missing exit code cannot pass.

All positive delegation oracles require the fixture's target artifacts to appear in the delegation
request text and in tool arguments from that delegation's child chat. Every assigned delegation
must have a matching target, and all required targets must be covered. Any tool counts,
including `bash`; a final textual claim alone cannot prove artifact access.

| Oracle | Required evidence |
| --- | --- |
| `delegate_confirmed` | Completed worker runs and complete receipts; final lead reply after every complete event; fixture's own `npm test` and direct rounding cases both exit 0 |
| `delegate_parallel` | Two distinct worker profiles, completed runs and receipts; lead final after completion; README Node line is 22 with old version gone; final names each fixture retry-count file with its corresponding value (3 and 5) |
| `worker_finishes` | Completed run and receipt; worker findings identify the planted non-draining queue defect, a fixture severity and the planted `src/queue.js` line; worker tool arguments name `src/queue.js` |
| `no_delegation` | Zero delegations; valid final containing both English terms from the fixture glossary |
| `no_delegation_but_work_done` | Zero delegations; valid final; `config/app.json` parses and timeout equals 5000 |
| `no_duplicate` | Valid final; at most one assignment per artifact across workers; `docs/usage.md` retains exactly one unchanged install sequence; lead or worker tool arguments name it |

Each run observation under `runs` (also under `workerRuns` for workers) records
`role`, `systemPromptChars` from ready `resources.systemPromptChars`, `availableTools` from
ready `tools`, `inheritHostResources`, and `systemPromptHashes`. `tools` remains the transcript's
actual tool calls; it is distinct from the ready tool allowlist. Comparison is role-aware, so
lead and worker allowlists are not compared to one another. Missing ready fields on completed
runs or different tool name sets for corresponding roles refuse the comparison with a reason.
Equal prompt lengths refuse comparison: for each task/role, the two arms' observed length sets
must be disjoint in dry and live batches, including across repeats.

In AB_DRY, the local model fixture observes actual outgoing request system/developer messages.
SHA-256 hashes of those messages are saved in `system-prompt-hashes.json` per task/ref, keyed
by the actual `sprout_turn_context.runId`, and copied to the corresponding run observations.
Workers sharing a provider/model never share their hash bucket. A missing hash or matching hashes across corresponding arm/task/roles
refuses comparison. Live providers do not expose request text to this harness; their hash field
is null. Before any live batch item starts, the batch runs one dry task per arm against those
prepared refs, prints both observed lead prompt hash sets, and saves `preflight.json` plus each
probe's evidence. Missing or shared hashes refuse the entire live batch. These probes are not
part of the measurement ledger. The hash includes all
observed text, including dynamic paths; different hashes alone cannot attribute a behavioral
difference to the intended prompt change.

Delegation/run facts and completion events come from domain functions and the DB. Actual tool
calls, final replies and provider usage come from persisted Pi transcripts, bound with
`sprout_turn_context.runId`. Every completed run requires startup/transcript/token evidence;
one healthy run cannot cover for another. Missing evidence is an error. Fixture token
usage is genuinely zero; live usage is recorded as returned. Strict lead-after-complete ordering
compares transcript millisecond timestamps against DB completion event timestamps.

A budget/deadline expiration is a timeout; an unrelated exception after the task budget is still
an error. Fixture close failures are recorded in `cleanupError` and preserve an already measured
verdict.

`wallClockPerPhase` records task fixture preparation, startup, sending, settle and judgement in
milliseconds. `refPreparationMs` is the separate once-per-ref install/build cost. `totalMs`
excludes shutdown. Each row's `childProcesses` records service/Worker commands and shutdown
codes/times; `commands.jsonl` records checkout/build/git commands with cwd, exit code and log.
Credentials stay in private evidence files and are excluded from command records.

Regression tests (temporary artifact fixtures and synthetic transcript/DB evidence):

```sh
node --test scripts/verify-live/crew-prompt-ab/*.test.mjs
```

Real server/Worker transport dry batch:

```sh
AB_DRY=1 AB_REF_A=baseline-ref AB_REF_B=prompt-ref AB_REPEAT=2 \
  AB_MODEL=sprout-verify-local/chat-owner \
  bash scripts/verify-live/crew-prompt-ab-run.sh
```

Dry mode scripts a lead answer and does not measure delegation quality. Positive delegation
tasks correctly fail when no delegation or artifact fix occurred. Tests cover the planted
artifact defects, changed/reverted/duplicated install steps, two workers assigned one artifact,
early lead replies, missing receipts, aborted/canceled/timed-out workers, missing ready fields,
identical hashes/SHAs, differing role tool sets, and interruption accounting.

Results remain `inconclusive` without a calibrated noise floor. Three repeats of six tasks yield
18 observations per arm, roughly ±11 percentage points standard error; differences under 20
points remain unresolved. Saturation at 0% or 100% is called out. Evidence is stored next to
`AB_OUT`; summaries describe only the current invocation, not earlier appended rows.
