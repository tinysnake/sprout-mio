import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "./core.mjs";
import { seedFixture } from "./fixtures.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { factsFrom } from "./evidence.mjs";

const facts = (patch = {}) => ({
  oracle: "delegate_confirmed",
  status: "failed",
  passed: false,
  runs: [
    { runId: "lead", status: "completed" },
    { runId: "worker", status: "completed" },
  ],
  artifactAssertions: [{ name: "rounding", exitCode: 0 }],
  delegatedCount: 1,
  workerRunTerminalStatuses: ["completed"],
  workerReportedComplete: [true],
  leadFinalReplyAtMs: 30,
  leadFinalReplyText: "Verified.",
  completeEventTimes: [20],
  requiredDelegationArtifacts: ["utils/format.js"],
  delegationEvidence: [
    {
      childChatId: "child",
      requestArtifacts: ["utils/format.js"],
      workerArtifacts: ["utils/format.js"],
    },
  ],
  ...patch,
});

test("ledger explains each failed gate with actual values, including the sanity probe request", () => {
  const cases = [
    ["runs", { runs: [{ runId: "unfinished", status: "running" }] }, "unfinished"],
    [
      "artifactsPass",
      { artifactAssertions: [{ name: "review", exitCode: 1, stderr: "missing line" }] },
      "missing line",
    ],
    ["validFinal", { leadFinalReplyText: "" }, "nonemptyText"],
    ["workersDone", { workerReportedComplete: [false] }, "reportedComplete"],
    ["afterComplete", { leadFinalReplyAtMs: 20 }, "strictlyAfter"],
    [
      "attribution",
      {
        delegationEvidence: [
          {
            childChatId: "probe-child",
            requestArtifacts: [],
            workerArtifacts: ["utils/format.js"],
          },
        ],
      },
      "probe-child",
    ],
  ];
  for (const [gate, patch, detail] of cases) {
    const row = facts(patch);
    core.finalizeVerdict(row);
    assert.equal(row.verdict.oracle, "delegate_confirmed");
    assert(row.verdict.failedGates.includes(gate));
    assert(JSON.stringify(row.verdict.gates[gate]).includes(detail));
    assert.equal(core.judge(row.oracle, row), false);
  }
  const row = facts({
    delegationEvidence: [
      { childChatId: "probe", requestArtifacts: [], workerArtifacts: ["utils/format.js"] },
      {
        childChatId: "fix",
        requestArtifacts: ["utils/format.js"],
        workerArtifacts: ["utils/format.js"],
      },
    ],
    delegatedCount: 2,
    workerRunTerminalStatuses: ["completed", "completed"],
    workerReportedComplete: [true, true],
    completeEventTimes: [19, 20],
  });
  core.finalizeVerdict(row);
  assert.deepEqual(row.verdict.failedGates, ["attribution"]);
});

test("anomalous and unstarted ledger outcomes carry execution reason rather than claim oracle failure", () => {
  for (const status of ["errored", "timeout", "aborted", "interrupted", "not_run"]) {
    const row = facts({
      status,
      passed: null,
      reason: "batch stopped",
      error: { message: "run terminated" },
      runs: [
        {
          runId: "startup",
          status: "failed",
          errorCode: "run_failed",
          errorMessage: "Agent run 执行失败",
          startedAt: null,
        },
      ],
    });
    core.finalizeVerdict(row);
    assert.equal(row.verdict.outcome, status);
    assert.equal(row.verdict.evaluated, false);
    assert.equal(row.verdict.execution.runs[0].errorCode, "run_failed");
    assert.equal(row.verdict.execution.reason, "batch stopped");
  }
  const row = facts({ oracle: "no_delegation", status: "timeout", passed: null });
  core.preserveOutcome(row, row.oracle, 1);
  core.finalizeVerdict(row);
  assert.equal(row.status, "failed");
  assert(row.verdict.failedGates.includes("noDelegation"));
});

test("facts retain pre-start run failure diagnostics in the ledger", () => {
  const row = factsFrom(
    {
      delegations: [],
      events: [],
      runs: [
        {
          id: "startup",
          chatId: "child",
          status: "failed",
          errorCode: "run_failed",
          errorMessage: "Agent run 执行失败",
          startedAt: null,
        },
      ],
    },
    "lead",
  );
  assert.equal(row.runs[0].errorCode, "run_failed");
  assert.equal(row.runs[0].errorMessage, "Agent run 执行失败");
});

test("single-file review accepts scoped basename references but rejects wrong file, line, severity and defect", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-review-basename-"));
  try {
    seedFixture("sandbox-review", root);
    const check = (text) =>
      artifactAssertions({ fixture: "sandbox-review" }, root, { workerFindings: [text] })[0]
        .exitCode;
    const finding =
      "Reviewed src/queue.js. Severity: CRITICAL. queue.js:5 Infinite loop: queue head is never removed.";
    assert.equal(check(finding), 0);
    for (const bad of [
      finding.replace("queue.js:5", "other.js:5"),
      finding.replace("queue.js:5", "queue.js:999"),
      finding.replace("CRITICAL", "cosmetic"),
      finding.replace("Infinite loop: queue head is never removed.", "naming issue"),
      finding.replace("Reviewed src/queue.js. ", ""),
      finding.replace("Reviewed src/queue.js.", "Reviewed other/queue.js."),
    ])
      assert.notEqual(check(bad), 0, bad);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
