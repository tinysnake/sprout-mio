# Task set 2 offline verification

Scope: four scenario groups, five new task IDs (the clarification group has two directions), plus three existing tasks classified as sanity. The canonical task list, prompts, member descriptions, oracle settings and failure-mode hypotheses remain in the single JSON block in `docs/plans/crew-prompt-ab.md`. No live batch was run. Cost metric calculations were not changed.

## Oracles

- `worker-takes-minutes`: one attributed delegation, three intact matrix outputs, worker duration at least 180000ms, lead processing at most 90000ms, `sleepMsTotal <= 500`, at most one delegation-list query before completion. The fixture performs actual continuous hashing for three 60000ms matrix entries; it does not sleep.
- `route-by-description`: one delegation and its actual execution profile must match the invoice arithmetic specialist among three similarly named members. Invoice arithmetic must also pass the fixture's executable checks.
- `clarify-before-guessing`: no delegation, one question asking which customer, unchanged inputs and no delivered customer summary.
- `resolve-from-context`: one attributed delegation, a Northstar summary matching the project context and customer data, completion receipt and final delivery without asking another question.
- `budgeted-parallel-delivery`: at least two attributed delegations covering all three correct outputs (one worker may handle two entries), at least two simultaneously running workers and two profiles, final delivery within 190000ms of sending the task. Three independent matrix entries each require 75000ms; serial execution requires at least 225000ms.

`donot-delegate-question`, `donot-delegate-small-edit`, and `no-duplicate-delegation` are sanity. Both normal and read-only rejudge summaries keep their counts separate from the main success denominator. Incomplete sanity still prevents batch comparison; inconsistent task categories also refuse comparison.

## Commands and results

- Mutation red: temporarily changed the routing oracle's expected profile equality to inequality; `node --test scripts/verify-live/crew-prompt-ab/taskset2.test.mjs` exited **1**, failing the positive routing delivery case. Log: `/tmp/crew-taskset2-red.log`. Restored equality before the green run.
- Green: `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs` exited **0**: 78 passed, 0 failed, 0 skipped. Log: `/tmp/crew-taskset2-all-tests.log`.
- Formatting: `pnpm exec vp fmt --check` with all task-set implementation and documentation files explicitly listed exited **0**.
- Lint: `pnpm exec vp lint` with the changed `.mjs` files explicitly listed exited **0**. Four existing `typescript(require-array-sort-compare)` warnings in the comparison and rejudge code remain.
- `git diff --check` exited **0**.

Full dry command (exit **0**, 22 planned and completed ledger rows):

```sh
AB_DRY=1 AB_MODEL=magpie/auto/deepseek-v4.1-flash AB_REF_A=277f506c15fe771bbd337efa259dc517c3ffc1cd AB_REF_B=0130cbece1fde9d5e34e328f05c00475d534b615 AB_OUT=/tmp/crew-ab-taskset2-dry.jsonl bash scripts/verify-live/crew-prompt-ab-run.sh
```

Actual new-task lines from `/tmp/crew-ab-taskset2-dry.log`:

```text
FAILED A worker-takes-minutes repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED B worker-takes-minutes repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED A route-by-description repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED B route-by-description repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED A clarify-before-guessing repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED B clarify-before-guessing repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED A resolve-from-context repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED B resolve-from-context repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED A budgeted-parallel-delivery repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
FAILED B budgeted-parallel-delivery repeat=1 out=/tmp/crew-ab-taskset2-dry.jsonl
```

The dry run used a scripted local model response. Its failed oracle outcomes are expected: it does not delegate, run matrix workloads, select a worker or ask for a customer. The full run's main denominator was 8 per arm, with 3 sanity items separately per arm. This verifies task planning, repository and machine setup, collection and oracle execution, including the three-machine fixture; it does not demonstrate a model behavior difference.

The supplemental five-task dry also exited **0** (10 completed rows, all expected oracle failures): same command with `AB_TASKS=worker-takes-minutes,route-by-description,clarify-before-guessing,resolve-from-context,budgeted-parallel-delivery` and `AB_OUT=/tmp/crew-ab-taskset2-final-dry.jsonl`. Its log is `/tmp/crew-ab-taskset2-final-dry.log`; evidence is `/tmp/crew-prompt-ab-1794885765933-69254`.

After allowing two delegations to cover three deliveries, a final budget-only dry exited **0** (2 completed rows, both expected oracle failures): same command with `AB_TASKS=budgeted-parallel-delivery` and `AB_OUT=/tmp/crew-ab-taskset2-budget-dry.jsonl`. Log: `/tmp/crew-ab-taskset2-budget-dry.log`; evidence: `/tmp/crew-prompt-ab-1794885935974-80255`.

Still unverified: whether these tasks distinguish the old and new behavior under real models, whether the coordination budgets are calibrated for live model latency, and the complete multi-minute workloads through live delegated worker execution. Those require an explicitly authorized live batch.
