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
| `SPROUT_PI_PROVIDER_ROOT` | Required for this live pilot: `/Users/snake/workspace/pi-extensions/pi-magpie` |

Both refs are fetched before resolution and pinned to full commit SHAs before either build.
Branch refs resolve from their fetch result; object refs and `HEAD` resolve after fetching origin.
The batch refuses to start if both arms resolve to the same commit, including different aliases
for that commit. `refs.json` and every ledger row record the resolved `head`; `ref` and
`testedRef` retain the requested ref.

Before preparation, `plan.json` enumerates every arm/task/repeat.

Prompt size inventory (no model calls):

```sh
node scripts/verify-live/crew-prompt-ab/prompt-inventory.mjs [ref-or-checkout]
```

The default ref is local `origin/main`; the inventory resolves it without fetching. Ref inputs
run in a detached temporary worktree that is removed in `finally`; existing checkouts are read
in place. Dependencies come from the harness installation (`node_modules` must be installed).
The JSON records the resolved SHA, fixed facts and installed Pi SDK version. The fixed fixture
uses a coding project, a short persona/description, stable role names/IDs and a canonical cwd;
it disables skills, prompt templates, Web extensions, memory and Machine leases. Repeat with
the same SDK version to reproduce counts; these are controlled inventory values, not per-task
ready snapshots.

The script evaluates the target runner's prompt expression, guide constants, registration
factories and tool allowlist. It calls the target `composeSystemPrompt` when present, captures
`registerTool` from the actual registration functions (including idle MCP), and includes SDK
read-only and codemode/search tools. Unregistered allowlist entries fail measurement. Dynamic
MCP tools require a Machine lease and are absent from this fixture. Counts use JS string.length
(UTF-16 code units). Tool totals sum top-level description plus parameter-schema description
values, excluding JSON syntax and example data. Sections include heading and trailing separators;
missing sections are zero, legacy HTML is identified from the runner constant, and the SDK's
rendered suffix is accounted separately so sections reconcile to the complete system prompt.

Each prepared arm saves `prompt-inventory-A.json` or `prompt-inventory-B.json` in its evidence
directory. Once both inventories exist, `summary.json.promptSizeComparison`, `prompt-size.md`
and the console report show each role's system/tool totals and `(1 - B / A) * 100` compression.
A zero baseline gives `null`/`n/a`; negative compression means growth. Prompt-size reporting is
independent of the behavioral comparison eligibility checks.

Cost fields are derived without model calls by `costMetricsFrom` in `cost-metrics.mjs`.
`delegations` counts persisted delegation records, including failed/blocked ones, rather
than attempted start-tool calls. `probeDelegations` counts requests labelled with the word
`probe`, `read-only`/`read only`, `只读`, or `侦察`; this is requested intent, not proof of compliance.
The existing corrected-oracle probe details live in `probeDelegationEvidence` so verdict
finalization cannot overwrite the numeric `probeDelegations` cost field; the rejudge report
continues to expose its existing aggregate probe-detail list.
`unmappedArtifacts` counts distinct paths from successful explicit `write`, `edit`, and
`sprout_remote_file_write` calls that do not match a file path named in any delegation
request. Reads and failed writes do not count; repeated writes to one path count once.
Relative request paths match suffixes at directory boundaries; bare filenames match basenames,
and `/private/tmp` normalizes to `/tmp`. Shell-created files are outside this explicit-write
metric; opaque nested writes or missing write results produce `null`.
`leadWallMs` and `workerWallMs` sum each role's run `settledAt - startedAt` in milliseconds,
including pauses; overlapping worker runs count separately. An unfinished/invalid clock
makes that role's sum `null`. `sleepMsTotal` sums lead `sleep` argument `ms` directly regardless
of tool success: requested sleep, not measured waiting. `toolCallsByRole` counts observed
top-level calls per role, including failures; nested calls are not expanded.
Missing transcripts/tool surfaces, opaque nested sleeps, missing roles and absent runtime
evidence remain `null`; only observed empty sets yield zero. The additional summary table
pairs A/B by task and repeat, keeps repeats separate, and preserves success-rate semantics.

Every planned item receives
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

Live pilot resource setup is identical in both arms. The fixture reads the active membership
epoch, canonical accessible directory and Machine root revision, then watches for actual delegated
runs. In one immediate transaction it calls the frozen arm's `requestCrewResource`,
`approveCrewResource` and `advanceCrewResources` using the actual current running lead identity.
It does not write lease tables or provide host write/shell tools. Reconciliation, remote execution
and draining still use the application. Atomic allocation avoids exposing a half-prepared request
when the scope is available. It does not guarantee allocation under contention: two delegations
sharing a writable scope can leave one request queued and its startup check can fail with
`Crew 资源尚未分配`. Treat that as an execution anomaly, not absent model delegation; the
[six-task sanity diagnosis](SANITY-DIAGNOSIS.md) records this observed limitation.

This is external fixture approval, not an observed model decision. The experiment now measures
behavior with resources available; it does not measure resource requesting, approval or allocation.
The bridge is needed because frozen domain dispatch supports `resources` but the exposed
`sprout_delegation_start` tool schema omits it. Product defects are reported without patching either
arm. Exact setup is recorded in `task-prompt.txt`, `resource-fixture.json` and `resource-fixture.log`;
`machine-exchanges.jsonl` captures HTTP remote-agent and nonempty Worker exchanges, with secrets
redacted. Original unprepared pilot transcripts remain separate evidence; their elapsed times are
not comparable to the prepared fixture. Use `AB_MODEL=magpie/auto/deepseek-v4.1-flash` and the
provider root above for live. No display keepalive is used.

Delegation/run facts and completion events come from domain functions and the DB. Actual tool
calls, final replies and provider usage come from persisted Pi transcripts, bound with
`sprout_turn_context.runId`. Every completed run requires startup/transcript/token evidence;
one healthy run cannot cover for another. Missing evidence is an error. Fixture token
usage is genuinely zero; live usage is recorded as returned. Strict lead-after-complete ordering
compares transcript millisecond timestamps against DB completion event timestamps.

A budget/deadline expiration is a timeout; an unrelated exception after the task budget is still
an error. `blocked` settles without `terminalAt` once actual result events have been consumed.
A `dispatched` event is bookkeeping and need not be acknowledged. Domain probes are bounded to
five seconds; a complete emitted snapshot can survive probe timeout with an independent
`evidenceProbe` diagnostic. A settled snapshot can still be judged after an observation timeout.
Later exceptions and fixture close failures preserve a measured verdict; close failures are
recorded in `cleanupError`.

Each ledger row and saved `result.json` includes `verdict`: `oracle`, `outcome`, `evaluated`,
`passed`, `failedGates`, and `gates`. Each applicable gate records its boolean subconditions and
actual evidence (run identity/status/errors, assertion exits/stderr, receipt/timestamp values,
and request/worker artifact mappings). Attribution also lists unmapped children and uncovered
targets. Run facts retain product `errorCode`/`errorMessage`; delegation facts retain the original
request and id. This requires no change to the artifact or attribution thresholds.

`verdict.execution` records the execution reason, error, non-completed runs, evidence probe/error
and cleanup diagnostics. For `errored`, `timeout`, `aborted`, `interrupted` and `not_run`,
`evaluated=false` and `passed=null`: unsatisfied gates are incomplete evidence, not a measured
model failure. Forbidden delegation remains a measured failure even if execution later stops.
A generic product run error may require `service.log` for its underlying cause.

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
