# Crew A/B live pilot fix1 implementation report

2026-11-16. Scope: harness, fixtures and their documentation only. No `src/`, product build configuration or A/B product commit was modified.

## Result and checkout identity

B single-task live passed: `delegate-one-fix`, `head=3c0f25c75f77689bfbf79349149cbe2abae6d1a7`, model `magpie/auto/deepseek-v4.1-flash`. Two real delegations completed, both workers reported completion, all four runs completed, and both artifact assertions exited 0. This proves the prepared execution path works; it does not prove there were no product defects or that B improves over A.

The user-specified directory is `/Users/snake/.t3/worktrees/sprout-mio/t3-11ee450b-a7694f35430153fd`. At task entry it was already on `t3/harness-verdict-eligibility-gates` at `88e276f`, with a clean tree. `t3/5b6c57cd` was checked out elsewhere, at `/Users/snake/.t3/worktrees/sprout-mio/t3-5b6c57cd-0f8dcf4f7a100e39`. Changes are left in the specified directory without switching either occupied branch. The patch is also exported as `/tmp/crew-ab-live-pilot-fix1.patch` for integration onto the requested branch. No commit was created.

A and B were addressed by immutable object IDs: A `277f506c15fe771bbd337efa259dc517c3ffc1cd`, B `3c0f25c75f77689bfbf79349149cbe2abae6d1a7`. B was actually executed. A was not rerun. The requested A branch name was absent locally and the local `t3/e49394a1` already pointed elsewhere; neither ref was moved. No product worktree was edited.

## Root causes

Product line numbers below refer to frozen B `3c0f25c75f77689bfbf79349149cbe2abae6d1a7`, not whichever commit a branch currently names.

1. **Unprepared resource context, followed by a masked valid rejection.** The original worker's `sprout_resource_request` used `crewChatId=cnv_5d09cdde`, which the saved DB identifies as the delegation child, not its parent Crew `cnv_273935a7`. It also guessed `directoryRevision=1` while the Machine root revision was 2. `src/domain/crew-resource.ts:89` begins eligibility checks; the wrong Crew subject is rejected before insertion at `src/domain/crew-resource.ts:313`. Replaying the exact original request against a SQLite backup of the original evidence DB with the frozen domain produced `code=forbidden, message=crew_epoch_changed`, and the resource request table remained empty. Thus no pending approval was expected for this request. The initial fixture only bound an accessible Machine and sent the raw task; it had neither registered approval nor supplied a correct complete resource scope. Host write/shell tools are intentionally absent for Crew workers.

   A fresh unprepared scratch live captured two actual `crew_resource` HTTP 403 responses with `{ok:false,error:{code:"forbidden"}}`, request IDs `req_d8a9058f` and `req_a6790d86`. The remote client only accepts 403 for task/chat call types at `src/extension/remote-client.ts:468`; `crew_resource` and `lease_mutate` reach `invalid_response` at `src/extension/remote-client.ts:480`. The transport therefore hides the real forbidden result. Old Crew `sprout_lease_acquire/handoff/grant/revoke_grant` rejection remains intentional (`src/server/remote-agent-gateway.ts:452`, `docs/crew-core.md:109`). No attempt was made to enable these calls.

2. **The documented dispatch preapproval path is missing from the exposed tool schema.** Domain dispatch accepts `resources` at `src/contracts/delegation.ts:55`, and `src/domain/delegation.ts:271` registers/approves it. However, `crewDelegationToolInputSchemas.sprout_delegation_start` at `src/contracts/delegation.ts:212` has no `resources` field. `src/extension/crew-delegation-tools.ts:31` parses through that strict schema. Adding instructions alone cannot make the model use this path. This product defect was not patched.

3. **Queued resource setup races worker startup.** An intermediate fixture attempt registered and approved the real request but left allocation to the scheduler. The worker failed with `AgentRunError/conflict`, cause `Crew 资源尚未分配`. The guard is `src/domain/agent-run.ts:588`; scheduler allocation is separate at `src/server/scheduler.ts:105`（原文引用 `continuation-scheduler.ts`，该文件已随对话接续一起移除并改名为 `scheduler.ts`）. Final fixture setup calls request, approval and allocation in one immediate transaction via the frozen domain, so its own prepared request is not exposed in a half-ready state. This only prepares the scratch fixture; it changes no product guard. It is not a general fix for contention or arbitrary multi-worker scheduling.

4. **The settle predicate waited for dispatch bookkeeping forever.** Historical `evidence.mjs:37` rejected every pending event. In the preserved B evidence all runs were completed, `dlg_b43a25ba` was blocked, its blocked event was acknowledged, but its `dispatched` event still appeared pending. Frozen `src/domain/delegation.ts:242` creates that event and `src/domain/delegation.ts:1060` maps absent delivery rows to pending. `blocked` already passed the status test; the actual missing condition was excluding `dispatched` from lead delivery waits. The fix is `scripts/verify-live/crew-prompt-ab/evidence.mjs:77`. Actual result events must still be consumed, and running workers still prevent settle.

5. **Probe/process errors replaced usable observations with an anomaly.** The old catch reset `status` and `passed` unconditionally, while `readEvidence` discarded stdout whenever the subprocess timed out. New `evidence.mjs:20` bounds each probe to 5 seconds, flushes its snapshot and exits explicitly, recovers a complete emitted snapshot on ETIMEDOUT, and classifies probe failure separately. `core.mjs:113` preserves an existing measured verdict through later exceptions. `run-task.mjs:461` uses that handler; `run-task.mjs:484` can judge a complete settled snapshot after an observation deadline/probe timeout. Artifact checks and attribution are still required. Incomplete snapshots and genuine run failures cannot be promoted to success.

6. **Completion response parsing remains a product defect.** In the passing live trial, HTTP 200 `req_73cae71c` returned `{ok:true,data:{projectId:"prj_4671b680",chatId:"cnv_813d7fdd",delegationId:"dlg_68c52ac0",status:"completed"}}`. The real worker tool result was nevertheless `{outcome:"unknown",reason:"invalid_response"}`; retries returned conflict. `readResponse` lacks successful `crew_resource`/`delegation_mutate` handling and falls through to execution parsing at `src/extension/remote-client.ts:241`. A local HTTP replay of both the captured forbidden resource response and the captured successful completion response through the frozen `createRemoteClient` reproduced `invalid_response` (exit 0). This defect was only reported. The successful trial had two delegations, including a second verification assignment; it was not a clean one-dispatch result.

## Implementation files

- `scripts/verify-live/crew-prompt-ab/evidence.mjs`: settled blocked results, dispatched bookkeeping exclusion, bounded probes, timeout snapshot recovery and diagnostic classification.
- `scripts/verify-live/crew-prompt-ab/core.mjs`: measured verdict preservation and probe timeout classification.
- `scripts/verify-live/crew-prompt-ab/run-task.mjs`: actual resource scope discovery, fixture lifecycle, prompt/evidence persistence, timeout recovery and judging with original artifact/attribution inputs.
- `scripts/verify-live/crew-prompt-ab/resource-fixture.mjs`: fixture-only watcher; calls the tested checkout's frozen domain APIs using the current lead and actual delegation run, with request/approval/allocation in an immediate transaction. No direct lease-table writes.
- `scripts/verify-live/crew-prompt-ab/exchange-trace.mjs`: passive scratch-service HTTP instrumentation for remote-agent and Worker exchanges, with credential/token redaction. Does not change requests or responses.
- `scripts/verify-live/crew-prompt-ab/live-recovery.test.mjs`: blocked/pending-dispatch regression, real subprocess timeout/snapshot regression and preserving both measured verdicts through later errors.
- `docs/plans/crew-prompt-ab.md`, `scripts/verify-live/crew-prompt-ab/README.md`: identical resource preparation policy and changed measurement scope.
- This report.

## Interpretation and limits

The original task JSON is unchanged. Both arms receive the same extra execution-environment policy and independently discovered real Machine scope. Resource preparation is an external fixture action, not evidence that the model asked for resources or the lead chose to approve them. The experiment now measures delegation, execution, result receipts and lead completion after resources are available. It does not measure resource requesting, approval, allocation or performance under contention. Lead-kept work still uses the product's own lead_run request/approval path; this pilot does not establish that path is healthy. The original A sleep/exploration behavior and B blocked transcript were preserved, and their timing must not be compared directly with this prepared fixture. A/B quality and speed comparison remains inconclusive; no full batch was run.

## Verification actually executed

| Check                                                                    | Exit    | Actual outcome                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial two regression tests, before fixes                               | 1       | Both failed: pending dispatched event prevented settle; verdict-preservation handler missing.                                                                                                                 |
| Additional subprocess/snapshot regression before recovery implementation | 1       | Timed-out probe threw and lost the already emitted snapshot.                                                                                                                                                  |
| Final `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs`        | 0       | 22 passed, 0 failed; log `/tmp/ab-pilot-fix1-tests-final.log`.                                                                                                                                                |
| Targeted `vp lint` on six changed JS modules                             | 0       | Two pre-existing array-sort warnings in `core.mjs`; no lint errors.                                                                                                                                           |
| `vp fmt` on six changed JS modules                                       | 0       | Formatted; initial attempt to use unavailable prettier exited 254 before falling back to the repository formatter.                                                                                            |
| `git diff --check`                                                       | 0       | No whitespace errors.                                                                                                                                                                                         |
| B single-task AB_DRY                                                     | 0       | Transport completed; ledger correctly says failed, because scripted dry lead did not delegate/fix the artifact. Both planted artifact assertions exited 1; this is expected, not a live-quality pass.         |
| Unprepared diagnostic B live                                             | 143     | Intentionally interrupted after capturing raw forbidden responses and confirming missing dispatch resources; not counted as a successful task.                                                                |
| First resource-sidecar startup                                           | 1       | Fixture SQL referred to absent `r.created_at`; corrected to rowid before next trial. No agent task ran.                                                                                                       |
| Approved-but-not-atomically-allocated B live                             | 1       | Captured real worker startup conflict `Crew 资源尚未分配`; corrected fixture setup only.                                                                                                                      |
| Atomically prepared B live                                               | 0       | Passed. Two completed delegations, four completed runs, two artifact assertions exited 0.                                                                                                                     |
| Original blocked evidence rejudge                                        | 0       | The preserved real snapshot now settles and correctly judges failed, even when assuming artifact checks passed; the worker never reported completion. Log `/tmp/ab-pilot-fix1-original-evidence-rejudge.log`. |
| Original request replay against copied DB                                | 0       | Asserted forbidden/crew_epoch_changed and zero resource insertions; original DB untouched.                                                                                                                    |
| Captured HTTP response replay through frozen client                      | 0       | Asserted masked 403 and rejected successful 200 completion.                                                                                                                                                   |
| Full A/B batch, A live, full product suite                               | skipped | Not required to prove this B single-task setup; no comparison or product correctness claim is made.                                                                                                           |

AB_DRY: ledger `/tmp/ab-pilot-fix1-dry.jsonl`; log `/tmp/ab-pilot-fix1-dry.log`; exit marker `/tmp/ab-pilot-fix1-dry.done`; evidence `/tmp/crew-prompt-ab-1794809297685-62020`.

Passing live: ledger `/tmp/ab-pilot-fix1-preapproved-live3.jsonl`; log `/tmp/ab-pilot-fix1-preapproved-live3.log`; exit marker `/tmp/ab-pilot-fix1-preapproved-live3.done`; evidence `/tmp/crew-prompt-ab-1794809573653-78446/1-B-delegate-one-fix`.

Passing live timing: ref preparation/install/build 12310 ms; task runner total 127076 ms, including settle 122103 ms and excluding shutdown. Artifact commands ran for 375 ms (`project-test`) and 87 ms (`rounding`). Background launch return time is not task runtime; workflow elapsed includes ref preparation and cleanup in addition to the runner value.

Diagnostic HTTP evidence: `/tmp/crew-prompt-ab-1794808741631-27969/1-B-delegate-one-fix/machine-exchanges.jsonl`. Queued-start failure evidence: `/tmp/crew-prompt-ab-1794809311395-62901/1-B-delegate-one-fix/service.log`. Original evidence is still `/tmp/crew-prompt-ab-1794806703876-7276`.

Replay artifacts: `/tmp/ab-pilot-fix1-resource-replay.mjs`, `/tmp/ab-pilot-fix1-resource-replay.sqlite`, `/tmp/ab-pilot-fix1-resource-replay.log`, `/tmp/ab-pilot-fix1-remote-replay.mjs`, `/tmp/ab-pilot-fix1-remote-replay.json`.

## Exact command for another single-task live pilot

Run in the implementation directory (or after applying the patch to its integration checkout). The evidence ledger gets a new directory every time. This starts a real background process with logs and an exit-code completion marker. No caffeinate/display keepalive or fixed sleep is involved.

```sh
cd /Users/snake/.t3/worktrees/sprout-mio/t3-11ee450b-a7694f35430153fd
ab_trial_dir="$(mktemp -d /tmp/crew-ab-rerun.XXXXXX)"
(
  SPROUT_PI_PROVIDER_ROOT=/Users/snake/workspace/pi-extensions/pi-magpie \
  AB_MODEL=magpie/auto/deepseek-v4.1-flash \
  AB_REF=3c0f25c75f77689bfbf79349149cbe2abae6d1a7 \
  AB_ARM=B AB_TASKS=delegate-one-fix AB_REPEAT=1 \
  AB_TASK_TIMEOUT_MS=1800000 AB_DRY=0 \
  AB_OUT="$ab_trial_dir/ledger.jsonl" \
    node scripts/verify-live/crew-prompt-ab/main.mjs > "$ab_trial_dir/live.log" 2>&1
  ab_rc=$?
  printf '%s\n' "$ab_rc" > "$ab_trial_dir/exit-code"
) < /dev/null > "$ab_trial_dir/launch.log" 2>&1 &
printf '%s\n' "$!" > "$ab_trial_dir/pid"
printf 'Logs, ledger and completion marker: %s\n' "$ab_trial_dir"
```
