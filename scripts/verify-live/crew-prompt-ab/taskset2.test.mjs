import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { taskSet, evaluateOracle, summarize, comparisonReasons, planBatch } from "./core.mjs";
import {
  fixtureDefinition,
  seedFixture,
  machineFixtureCount,
  scopeForWorker,
} from "./fixtures.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { maxActiveWorkers, successPopulation, taskset2Oracles } from "./taskset2.mjs";
import { summarizeRejudged } from "./rejudge.mjs";

const tasks = taskSet(
  fileURLToPath(new URL("../../../docs/plans/crew-prompt-ab.md", import.meta.url)),
);
const taskFor = (id) => tasks.find((task) => task.id === id);

function delivery(id) {
  const task = taskFor(id);
  const targets = fixtureDefinition(task.fixture).expected.delegationArtifacts;
  const count = task.oracleConfig.delegationCount ?? targets.length;
  return {
    oracleConfig: task.oracleConfig,
    delegatedCount: count,
    requiredDelegationArtifacts: targets,
    artifactAssertions: [{ exitCode: 0 }],
    leadFinalReplyAtMs: 181100,
    leadFinalReplyText: "交付已完成。",
    completeEventTimes: Array(count).fill(181000),
    sleepMsTotal: 0,
    expectedWorkerProfileId: "worker-0",
    projectContext: task.projectContext,
    taskSentAtMs: 0,
    workerReportedComplete: Array(count).fill(true),
    delegationEvidence: Array.from({ length: count }, (_, index) => ({
      workerProfileId: `worker-${index}`,
      childChatId: `child-${index}`,
      status: "completed",
      requestArtifacts: count === 1 ? targets : [targets[index]],
      workerArtifacts: count === 1 ? targets : [targets[index]],
    })),
    workerRuns: Array.from({ length: count }, (_, index) => ({
      profileId: `worker-${index}`,
      chatId: `child-${index}`,
      status: "completed",
      startedAt: 1000,
      settledAt: 181000,
    })),
    runs: [{ role: "lead", status: "completed", startedAt: 0, settledAt: 1000, tools: [] }],
  };
}
const verdict = (id, facts) => evaluateOracle(taskFor(id).oracle, facts);

for (const id of [
  "worker-takes-minutes",
  "route-by-description",
  "resolve-from-context",
  "budgeted-parallel-delivery",
]) {
  test(`${id}: accepts complete attributed delivery; rejects absent workers, artifacts and receipts`, () => {
    const facts = delivery(id);
    assert.equal(verdict(id, facts).passed, true);
    for (const patch of [
      { delegatedCount: 0 },
      { artifactAssertions: [{ exitCode: 1 }] },
      { workerRuns: [] },
      { workerReportedComplete: [] },
      { completeEventTimes: [] },
      { requiredDelegationArtifacts: [] },
      { leadFinalReplyAtMs: 180999 },
    ]) {
      assert.equal(verdict(id, { ...facts, ...patch }).passed, false, JSON.stringify(patch));
    }
  });
}

test("long worker rejects waiting, repeated list calls, short work and over-budget lead", () => {
  const facts = delivery("worker-takes-minutes");
  for (const patch of [
    { sleepMsTotal: 501 },
    { runs: [{ role: "lead", status: "completed", startedAt: 0, settledAt: 91000, tools: [] }] },
    {
      runs: [
        {
          role: "lead",
          status: "completed",
          startedAt: 0,
          settledAt: 1000,
          tools: [
            { name: "sprout_delegation_list", atMs: 100 },
            { name: "sprout_delegation_list", atMs: 200 },
          ],
        },
      ],
    },
    {
      workerRuns: [
        { profileId: "worker-0", status: "completed", startedAt: 1000, settledAt: 2000 },
      ],
    },
  ])
    assert.equal(
      verdict("worker-takes-minutes", { ...facts, ...patch }).passed,
      false,
      JSON.stringify(patch),
    );
  facts.runs[0].tools = [
    { name: "sprout_delegation_list", atMs: 100 },
    { name: "sprout_delegation_list", atMs: 181001 },
  ];
  assert.equal(verdict("worker-takes-minutes", facts).passed, true);
});

test("routing rejects wrong worker, broadcast and mismatched execution profile", () => {
  const facts = delivery("route-by-description");
  for (const patch of [
    { expectedWorkerProfileId: null },
    { expectedWorkerProfileId: "worker-1" },
    { delegatedCount: 3 },
    { workerRuns: [{ profileId: "worker-2", status: "completed" }] },
  ]) {
    assert.equal(verdict("route-by-description", { ...facts, ...patch }).passed, false);
  }
});

test("paired ambiguity asks Human once only without context, and delegates with context", () => {
  const facts = {
    oracleConfig: taskFor("clarify-before-guessing").oracleConfig,
    runs: [{ status: "completed" }],
    artifactAssertions: [{ exitCode: 0 }],
    delegatedCount: 0,
    leadFinalReplyText: "这次交付选哪个客户？",
    leadFinalReplyAtMs: 1000,
  };
  assert.equal(verdict("clarify-before-guessing", facts).passed, true);
  for (const patch of [
    { delegatedCount: 1 },
    { leadFinalReplyText: "选 Northstar。" },
    { leadFinalReplyText: "什么时候要？" },
    { leadFinalReplyText: "客户摘要已完成，要看吗？" },
  ])
    assert.equal(verdict("clarify-before-guessing", { ...facts, ...patch }).passed, false);
  // 顺口多确认一句（何时要）不算失败，只记 extraConfirmation 信号。
  const extra = verdict("clarify-before-guessing", { ...facts, leadFinalReplyText: "哪个客户？什么时候要？" });
  assert.equal(extra.passed, true);
  assert.equal(extra.gates.clarification.actual.extraConfirmation, true);
  const resolved = delivery("resolve-from-context");
  assert.equal(
    verdict("resolve-from-context", { ...resolved, leadFinalReplyText: "哪个客户？" }).passed,
    true,
  );
  assert.equal(
    verdict("resolve-from-context", { ...resolved, projectContext: null }).passed,
    false,
  );
});

test("parallel budget uses overlapping execution intervals, no boundary or serial false positive", () => {
  const facts = delivery("budgeted-parallel-delivery");
  const serial = facts.workerRuns.map((run, index) => ({
    ...run,
    startedAt: index * 75000,
    settledAt: (index + 1) * 75000,
  }));
  assert.equal(maxActiveWorkers(serial), 1);
  assert.equal(
    verdict("budgeted-parallel-delivery", { ...facts, workerRuns: serial }).passed,
    false,
  );
  assert.equal(
    verdict("budgeted-parallel-delivery", { ...facts, leadFinalReplyAtMs: 190001 }).passed,
    false,
  );
  assert.equal(
    verdict("budgeted-parallel-delivery", { ...facts, taskSentAtMs: null }).passed,
    false,
  );
  assert.equal(
    maxActiveWorkers([
      { startedAt: 0, settledAt: 5 },
      { startedAt: 5, settledAt: 10 },
      { startedAt: null, settledAt: 8 },
    ]),
    1,
  );
});

test("budget permits two delegations covering three deliveries", () => {
  const facts = delivery("budgeted-parallel-delivery");
  facts.delegatedCount = 2;
  facts.workerRuns = facts.workerRuns.slice(0, 2);
  facts.workerReportedComplete = [true, true];
  facts.completeEventTimes = [181000, 181000];
  facts.delegationEvidence = facts.delegationEvidence.slice(0, 2);
  facts.delegationEvidence[0].requestArtifacts.push("reports/docs.json");
  facts.delegationEvidence[0].workerArtifacts.push("reports/docs.json");
  assert.equal(verdict("budgeted-parallel-delivery", facts).passed, true);
});

test("matrix attribution accepts successful assigned build commands, not lead-only work", () => {
  const facts = delivery("worker-takes-minutes");
  facts.artifactCommands = fixtureDefinition("sandbox-minutes").expected.artifactCommands;
  facts.delegationEvidence[0].requestArtifacts = [];
  facts.delegationEvidence[0].workerArtifacts = [];
  facts.delegationEvidence[0].requestSummary = Object.values(facts.artifactCommands).join(" && ");
  facts.workerRuns[0].tools = Object.values(facts.artifactCommands).map((command) => ({
    arguments: { command },
    isError: false,
  }));
  assert.equal(verdict("worker-takes-minutes", facts).passed, true);
  facts.workerRuns[0].tools[0].isError = true;
  assert.equal(verdict("worker-takes-minutes", facts).passed, false);
});

test("planner and all new repositories are usable; artifacts reject missing or fabricated outcomes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ab-taskset2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const added = tasks.filter((task) => taskset2Oracles.includes(task.oracle));
  assert.equal(added.length, 5);
  assert.equal(planBatch([{ arm: "A" }, { arm: "B" }], added, 1).length, 10);
  for (const task of added) {
    assert(!/\b(eval|judge|test|rubric|score)\b/i.test(task.prompt));
    const worktree = join(root, task.id);
    seedFixture(task.fixture, worktree);
    const facts = { machineScopes: [{ worktree }] };
    const baseline = artifactAssertions(task, worktree, facts);
    assert(baseline.length > 0);
    assert.equal(
      baseline.every((check) => check.exitCode === 0),
      task.id === "clarify-before-guessing",
    );
    const expected = fixtureDefinition(task.fixture).expected;
    if (expected.matrix) {
      assert.equal(
        spawnSync(process.execPath, ["--check", join(worktree, "scripts/build.cjs")]).status,
        0,
      );
      mkdirSync(join(worktree, "reports"));
      for (const { label, digest } of expected.matrix)
        writeFileSync(
          join(worktree, `reports/${label}.json`),
          JSON.stringify({
            label,
            digest,
            iterations: 1000,
            startedAtMs: 1,
            finishedAtMs: expected.durationMs + 1,
            cpuMs: 100,
          }),
        );
      assert(artifactAssertions(task, worktree, facts).every((check) => check.exitCode === 0));
      writeFileSync(join(worktree, "scripts/build.cjs"), "console.log('skipped');\n");
      assert.equal(artifactAssertions(task, worktree, facts)[0].exitCode, 1);
      writeFileSync(
        join(worktree, "scripts/build.cjs"),
        fixtureDefinition(task.fixture).files["scripts/build.cjs"],
      );
      writeFileSync(join(worktree, `reports/${expected.matrix[0].label}.json`), "{}");
      assert(artifactAssertions(task, worktree, facts).some((check) => check.exitCode !== 0));
    } else if (expected.customer) {
      mkdirSync(join(worktree, "reports"));
      writeFileSync(join(worktree, "reports/customer.md"), "Customer: Harbor\nTotal: 17\n");
      assert.equal(artifactAssertions(task, worktree, facts)[0].exitCode, 1);
      writeFileSync(join(worktree, "reports/customer.md"), "Customer: Northstar\nTotal: 42\n");
      assert.equal(artifactAssertions(task, worktree, facts)[0].exitCode, 0);
    } else if (expected.untouched) {
      writeFileSync(join(worktree, "data/customers.json"), "{}");
      assert.equal(artifactAssertions(task, worktree, facts)[0].exitCode, 1);
    } else {
      writeFileSync(
        join(worktree, "src/totals.js"),
        "exports.total=rows=>rows.reduce((sum,row)=>sum+row.cents,0)/100;\n",
      );
      assert(artifactAssertions(task, worktree, facts).every((check) => check.exitCode === 0));
    }
  }
  const scopes = Array.from({ length: 3 }, (_, index) => ({ workerProfileId: `w${index}` }));
  assert.equal(machineFixtureCount("budgeted_parallel_delivery"), 3);
  assert.equal(scopeForWorker(scopes, "w2"), scopes[2]);
});

test("sanity has its own counts and cannot dilute main success denominator", () => {
  assert.deepEqual(
    tasks.filter((task) => task.category === "sanity").map((task) => task.id),
    ["donot-delegate-question", "donot-delegate-small-edit", "no-duplicate-delegation"],
  );
  const rows = [
    { arm: "A", task: "primary", status: "failed" },
    { arm: "A", task: "sanity", category: "sanity", status: "passed" },
  ];
  const summary = summarize(rows, { batch: false });
  assert.equal(summary.groups.find((group) => group.group === "A / ALL").completed, 1);
  assert.equal(summary.groups.find((group) => group.group === "A / ALL").passed, 0);
  assert.equal(summary.groups.find((group) => group.group === "A / SANITY").passed, 1);
  assert.equal(summary.successPopulation, successPopulation);
  const rejudged = summarizeRejudged(
    rows.map((row) => ({
      ...row,
      probeDelegationEvidence: [],
      verdict: { evaluated: true, passed: row.status === "passed", failedGates: [] },
      verdictCorrected: { evaluated: true, passed: row.status === "passed", failedGates: [] },
    })),
  );
  assert.equal(rejudged.readings.verdict.A.total, 1);
  assert.equal(rejudged.readings.verdict.A.passed, 0);
  assert.equal(rejudged.sanityReadings.verdict.A.passed, 1);
  assert.equal(rejudged.successPopulation, successPopulation);
  assert(
    comparisonReasons([
      { ...rows[0], category: "primary" },
      { ...rows[0], arm: "B", category: "sanity" },
    ]).some((reason) => reason.includes("task category differs")),
  );
  assert(comparisonReasons([rows[1]]).some((reason) => reason.includes("no primary items")));
  assert(
    comparisonReasons([{ ...rows[1], status: "timeout" }]).some((reason) =>
      reason.includes("incomplete"),
    ),
  );
});
