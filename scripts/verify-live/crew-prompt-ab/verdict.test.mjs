import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "./core.mjs";
import { seedFixture } from "./fixtures.mjs";
import * as fixtures from "./fixtures.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { factsFrom } from "./evidence.mjs";
import { rejudgeRow, rejudgeLedger, summarizeRejudged } from "./rejudge.mjs";

const corrected = (name, row) => core.evaluateOracle(name, row, { corrected: true });
const mapped = (id, profile, files) => ({
  delegationId: id,
  workerProfileId: profile,
  requestSummary: files.join(", "),
  requestArtifacts: files,
  workerArtifacts: files,
});
const parallelFacts = (extra = []) => {
  const evidence = [
    mapped("a", "one", ["src/retry.js", "config/retry.json"]),
    mapped("b", "two", ["README.md"]),
    ...extra,
  ];
  return facts({
    oracle: "delegate_parallel",
    delegatedCount: evidence.length,
    requiredDelegationArtifacts: ["src/retry.js", "config/retry.json", "README.md"],
    delegationEvidence: evidence,
    distinctWorkerProfiles: ["one", "two"],
    workerRunTerminalStatuses: evidence.map(() => "completed"),
    workerReportedComplete: evidence.map(() => true),
    completeEventTimes: evidence.map(() => 20),
  });
};

test("correction 1: real retry replies accept line references; missing or wrong counts fail", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-retry-"));
  try {
    seedFixture("sandbox-parallel", root);
    writeFileSync(join(root, "README.md"), "# Sandbox\nRequires Node 22.\n");
    const replies = JSON.parse(readFileSync(new URL("./parallel-replies.json", import.meta.url)));
    const check = (text, options = { corrected: true }) =>
      artifactAssertions(
        { fixture: "sandbox-parallel" },
        root,
        { leadFinalReplyText: text },
        options,
      )[0].exitCode;
    for (const sample of replies) {
      assert.equal(check(sample.leadFinalReplyText, { corrected: false }), 1);
      assert.equal(check(sample.leadFinalReplyText), 0, `${sample.arm} r${sample.repeat}`);
    }
    for (const text of [
      "src/retry.js:3; config/retry.json:5",
      "src/retry.js config/retry.json",
      "src/retry.js:13; config/retry.json:15",
      "src/retry.js#L13; config/retry.json#L15",
      "src/retry.js line 13; config/retry.json line 15",
      "src/retry.js:1 = 5; config/retry.json:1 = 3",
      "src/retry.js:1 = 30; config/retry.json:1 = 5",
      "other/src/retry.js:1 = 3; other/config/retry.json:1 = 5",
    ])
      assert.equal(check(text), 1, text);
    for (const suffix of [":19", "#L19", " line 19"])
      assert.equal(check(`src/retry.js${suffix} = 3; config/retry.json${suffix} = 5`), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correction 2: mapped work plus probe passes corrected attribution; unrelated work fails", () => {
  const probe = {
    delegationId: "probe",
    requestSummary: "test delegation start",
    requestArtifacts: [],
    workerArtifacts: [],
  };
  const row = parallelFacts([probe]);
  assert.equal(core.evaluateOracle(row.oracle, row).gates.attribution.passed, false);
  assert.equal(corrected(row.oracle, row).gates.attribution.passed, true);
  for (const delegationEvidence of [[probe], [mapped("decoy", "one", ["unrelated.txt"])], []]) {
    const result = corrected(row.oracle, {
      ...row,
      delegationEvidence,
      delegatedCount: delegationEvidence.length,
    });
    assert.equal(result.gates.attribution.passed, false);
  }
  assert.equal(
    corrected(row.oracle, { ...row, delegationEvidence: row.delegationEvidence.slice(1) }).gates
      .attribution.passed,
    false,
  );
});

test("correction 3: two artifact-producing profiles tolerate a probe, but same profile or no work fails", () => {
  const probe = {
    delegationId: "probe",
    requestSummary: "test delegation start",
    requestArtifacts: [],
    workerArtifacts: [],
  };
  const row = parallelFacts([probe]);
  assert.equal(core.evaluateOracle(row.oracle, row).gates.parallel.passed, false);
  assert.equal(corrected(row.oracle, row).gates.parallel.passed, true);
  for (const evidence of [
    row.delegationEvidence.map((d) => ({ ...d, workerProfileId: "same" })),
    [row.delegationEvidence[0], probe],
    [probe, probe],
  ]) {
    assert.equal(
      corrected(row.oracle, { ...row, delegationEvidence: evidence }).gates.parallel.passed,
      false,
    );
  }
  const broken = { ...row, workerReportedComplete: [true, true, false] };
  assert.equal(corrected(row.oracle, broken).passed, false);
});

test("correction 4: no_duplicate needs an artifact-specific review conclusion, not a delegation", () => {
  const row = facts({
    oracle: "no_duplicate",
    delegatedCount: 0,
    artifactToolCalls: ["docs/usage.md"],
    delegationsPerArtifact: { "docs/usage.md": 0 },
  });
  assert.equal(core.evaluateOracle(row.oracle, row).passed, true);
  assert.equal(corrected(row.oracle, row).passed, false);
  for (const text of [
    "已核对 docs/usage.md：没有遗漏，无需补写。",
    "Reviewed docs/usage.md: no missing steps.",
  ])
    assert.equal(corrected(row.oracle, { ...row, leadFinalReplyText: text }).passed, true);
  for (const text of [
    "docs/usage.md",
    "没有遗漏。",
    "稍后核对 docs/usage.md。",
    "docs/usage.md 已核对。",
    "已核对 docs/usage.md：仍有遗漏，稍后补写。",
  ])
    assert.equal(corrected(row.oracle, { ...row, leadFinalReplyText: text }).passed, false, text);
  assert.equal(corrected(row.oracle, row).gates.noDuplicate.actual.delegatedCount, 0);
});

test("correction 5: pin low and retain requested versus effective thinking", () => {
  const source = readFileSync(new URL("./run-task.mjs", import.meta.url), "utf8");
  assert.match(source, /effort: process\.env\.AB_THINKING \?\? "low"/);
  assert.doesNotMatch(source, /effort: "off"/);
  const f = factsFrom(
    {
      delegations: [],
      events: [],
      runs: [
        {
          id: "run",
          chatId: "lead",
          status: "failed",
          configSnapshot: { profile: { effort: "off" }, thinking: "low" },
        },
      ],
    },
    "lead",
  );
  assert.equal(f.runs[0].thinkingRequested, "off");
  assert.equal(f.runs[0].thinkingEffective, "low");
  const row = (arm, thinkingEffective) => ({
    arm,
    task: "t",
    status: "passed",
    head: arm.toLowerCase().repeat(40),
    runs: [
      {
        role: "lead",
        status: "completed",
        systemPromptChars: arm === "A" ? 10 : 20,
        availableTools: ["read"],
        inheritHostResources: false,
        thinkingEffective,
      },
    ],
  });
  assert.deepEqual(core.comparisonReasons([row("A", "low"), row("B", "low")]), []);
  assert(
    core
      .comparisonReasons([row("A", "low"), row("B", "high")])
      .some((r) => r.includes("thinking levels differ")),
  );
  assert(
    core
      .comparisonReasons([row("A", "low"), row("B", null)])
      .some((r) => r.includes("missing effective thinking")),
  );
});

test("correction 6: parallel fixture assigns independent machines by worker profile", () => {
  assert.equal(fixtures.machineFixtureCount("delegate_parallel"), 2);
  assert.equal(fixtures.machineFixtureCount("delegate_confirmed"), 1);
  const scopes = [
    { machineId: "m1", workerProfileId: "one" },
    { machineId: "m2", workerProfileId: "two" },
  ];
  assert.equal(fixtures.scopeForWorker(scopes, "one").machineId, "m1");
  assert.equal(fixtures.scopeForWorker(scopes, "two").machineId, "m2");
  assert.throws(() => fixtures.scopeForWorker(scopes, "unknown"));
  const root = mkdtempSync(join(tmpdir(), "ab-two-clones-"));
  try {
    const machines = scopes.map((s, i) => ({ ...s, worktree: join(root, String(i)) }));
    for (const machine of machines) seedFixture("sandbox-parallel", machine.worktree);
    writeFileSync(join(machines[1].worktree, "README.md"), "Requires Node 22.\n");
    assert.equal(
      fixtures.parallelAssertionRoot(machines, "Requires Node 22."),
      machines[1].worktree,
    );
    assert.match(readFileSync(join(machines[0].worktree, "README.md"), "utf8"), /Node 18/);
    assert.throws(() =>
      fixtures.parallelAssertionRoot([machines[0], machines[0]], "Requires Node 22."),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejudge is read-only, excludes anomalies and is repeatable with incomplete trailing bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-rejudge-"));
  try {
    const row = { ...parallelFacts(), arm: "A", task: "p", repeat: 1, status: "failed" };
    const input = join(root, "ledger.jsonl");
    const bytes = JSON.stringify(row) + '\n{"partial":';
    writeFileSync(input, bytes);
    const a = rejudgeLedger(input, join(root, "one.jsonl"));
    const b = rejudgeLedger(input, join(root, "two.jsonl"));
    assert.deepEqual(a, b);
    assert.equal(a.rows, 1);
    assert.equal(a.source.ignoredTrailingBytes, 11);
    assert.equal(readFileSync(input, "utf8"), bytes);
    assert.equal(
      readFileSync(join(root, "one.jsonl"), "utf8"),
      readFileSync(join(root, "two.jsonl"), "utf8"),
    );
    assert.throws(() => rejudgeLedger(input, input));
    assert.throws(() => rejudgeLedger(input, join(root, "one.jsonl")));
    const anomaly = rejudgeRow({ ...row, status: "errored" });
    assert.equal(anomaly.verdict.passed, null);
    assert.equal(anomaly.verdictCorrected.passed, null);
    assert.equal(anomaly.verdictCorrected.evaluated, false);
    const summary = summarizeRejudged([anomaly]);
    assert.equal(summary.readings.verdictCorrected.A.excluded, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejudge artifact reads fail closed and recorded commands never run", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-rejudge-files-"));
  try {
    seedFixture("sandbox-parallel", root);
    const row = {
      ...parallelFacts(),
      status: "failed",
      oracle: "delegate_parallel",
      leadFinalReplyText: "src/retry.js:1 = 3; config/retry.json:1 = 5",
      artifactAssertions: [
        {
          name: "parallel",
          exitCode: 1,
          cwd: root,
          command: ["false"],
          stderr: "AssertionError [ERR_ASSERTION]: lead names retry count src/retry.js = 3",
        },
      ],
    };
    assert.equal(rejudgeRow(row).artifactAssertionsCorrected[0].exitCode, 1, "README still old");
    writeFileSync(join(root, "README.md"), "Requires Node 22.\n");
    const judged = rejudgeRow(row);
    assert.equal(judged.artifactAssertionsCorrected[0].exitCode, 0);
    assert.equal(judged.artifactAssertions[0].exitCode, 1);
    assert.equal(row.artifactAssertionsCorrected, undefined);
    assert.equal(judged.rejudge.evidence.length, 3);
    rmSync(join(root, "config/retry.json"));
    assert.equal(rejudgeRow(row).artifactAssertionsCorrected[0].exitCode, 1);
    assert.equal(
      rejudgeRow({
        ...row,
        artifactAssertions: [{ ...row.artifactAssertions[0], stderr: "unrelated error" }],
      }).artifactAssertionsCorrected[0].exitCode,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
