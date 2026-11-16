import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  taskSet,
  judge,
  seedFixture,
  fixtureDefinition,
  classifyRuns,
  comparisonReasons,
  planBatch,
  summarize,
} from "./core.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { factsFrom, assistantMessagesByRun, settled, systemPromptEvidence } from "./evidence.mjs";
const tasks = taskSet(resolve("docs/plans/crew-prompt-ab.md"));
const facts = (overrides = {}) => ({
  runs: [{ runId: "lead", status: "completed" }],
  delegatedCount: 1,
  distinctWorkerProfiles: ["worker"],
  workerRunTerminalStatuses: ["completed"],
  workerReportedComplete: [true],
  leadFinalReplyAtMs: 30,
  leadFinalReplyText: "Verified.",
  completeEventTimes: [20],
  delegationsPerArtifact: {},
  artifactAssertions: [{ exitCode: 0 }],
  requiredDelegationArtifacts: ["utils/format.js"],
  delegationEvidence: [
    { requestArtifacts: ["utils/format.js"], workerArtifacts: ["utils/format.js"] },
  ],
  artifactToolCalls: ["docs/usage.md"],
  ...overrides,
});
function withFixture(name, action) {
  const root = mkdtempSync(join(tmpdir(), "ab-test-"));
  try {
    seedFixture(name, root);
    return action(root, fixtureDefinition(name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const checks = (fixture, root, f = {}) => artifactAssertions({ fixture }, root, f);
const pass = (rows) => rows.every((r) => r.exitCode === 0);

test("task list and oracle names remain in the owning document", () => {
  assert.equal(tasks.length, 6);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 6);
});
test("claims and complete receipts cannot substitute for artifact commands", () => {
  for (const task of tasks)
    assert.equal(judge(task.oracle, facts({ artifactAssertions: [] })), false);
  assert.equal(judge("delegate_confirmed", facts()), true);
  assert.equal(judge("delegate_confirmed", facts({ leadFinalReplyAtMs: 19 })), false);
});
test("project test and direct rounding probe both detect planted floor defect", () => {
  withFixture("sandbox-fix", (root) => {
    const red = checks("sandbox-fix", root);
    assert.equal(red.length, 2);
    assert(red.every((r) => r.exitCode !== 0));
    writeFileSync(
      join(root, "utils/format.js"),
      "exports.round = value => Math.round(value * 100) / 100;\n",
    );
    assert(pass(checks("sandbox-fix", root)));
    // A lying project test command cannot make the rounding assertion pass.
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node -e 0"}}');
    writeFileSync(
      join(root, "utils/format.js"),
      "exports.round = value => Math.floor(value * 100) / 100;\n",
    );
    const lying = checks("sandbox-fix", root);
    assert.equal(lying[0].exitCode, 0);
    assert.notEqual(lying[1].exitCode, 0);
  });
});
test("parallel needs README 22, no old version, both retry paths and two completed workers", () => {
  withFixture("sandbox-parallel", (root, { expected }) => {
    const f = {
      leadFinalReplyText: Object.entries(expected.retryCounts)
        .map(([file, value]) => `${file}: ${value}`)
        .join("\n"),
    };
    assert(!pass(checks("sandbox-parallel", root, f)));
    writeFileSync(join(root, "README.md"), expected.nodeLine + "\n");
    assert(pass(checks("sandbox-parallel", root, f)));
    assert(!pass(checks("sandbox-parallel", root, { leadFinalReplyText: expected.retryFiles[0] })));
    writeFileSync(join(root, "README.md"), expected.nodeLine + "\nIssue 18 is resolved.");
    assert(pass(checks("sandbox-parallel", root, f)));
    assert(
      !pass(
        checks("sandbox-parallel", root, { leadFinalReplyText: expected.retryFiles.join(" ") }),
      ),
    );
    assert(
      !pass(
        checks("sandbox-parallel", root, {
          leadFinalReplyText: f.leadFinalReplyText.replace(": 3", ": 30"),
        }),
      ),
    );
    assert(
      !pass(
        checks("sandbox-parallel", root, {
          leadFinalReplyText: "src/retry.js: 5\nconfig/retry.json: 3",
        }),
      ),
    );
    writeFileSync(join(root, "README.md"), expected.nodeLine + "\n" + expected.oldNodeLine);
    assert(!pass(checks("sandbox-parallel", root, f)));
  });
  const f = facts({
    delegatedCount: 2,
    distinctWorkerProfiles: ["a", "b"],
    workerRunTerminalStatuses: ["completed", "completed"],
    workerReportedComplete: [true, true],
    completeEventTimes: [20, 21],
    delegationEvidence: [
      { requestArtifacts: ["utils/format.js"], workerArtifacts: ["utils/format.js"] },
      { requestArtifacts: ["utils/format.js"], workerArtifacts: ["utils/format.js"] },
    ],
  });
  assert(judge("delegate_parallel", f));
  for (const patch of [
    { distinctWorkerProfiles: ["a"] },
    { workerReportedComplete: [true, false] },
    { workerRunTerminalStatuses: ["completed", "aborted"] },
    { leadFinalReplyAtMs: 21 },
  ])
    assert.equal(judge("delegate_parallel", { ...f, ...patch }), false);
});
test("review requires the planted defect, fixture severity and precise source reference", () => {
  withFixture("sandbox-review", (root, { expected: e }) => {
    const finding = `${e.severities[1]} ${e.file}:${e.defectLine} Infinite loop: queue head is never removed.`;
    assert(pass(checks("sandbox-review", root, { workerFindings: [finding] })));
    for (const bad of [
      "complete",
      finding.replace("Infinite loop: queue head is never removed.", "naming issue"),
      finding.replace(e.severities[1], "cosmetic"),
      finding.replace(`:${e.defectLine}`, ":999"),
    ])
      assert(!pass(checks("sandbox-review", root, { workerFindings: [bad] })));
  });
  for (const status of ["aborted", "canceled", "timed_out", "interrupted"])
    assert.equal(judge("worker_finishes", facts({ workerRunTerminalStatuses: [status] })), false);
});
test("question and small edit verify exact fixture outcomes", () => {
  withFixture("sandbox-question", (root, { expected: e }) => {
    assert(pass(checks("sandbox-question", root, { leadFinalReplyText: e.terms.join(" ") })));
    assert(!pass(checks("sandbox-question", root, { leadFinalReplyText: e.terms[0] })));
  });
  withFixture("sandbox-small-edit", (root, { expected: e }) => {
    assert(!pass(checks("sandbox-small-edit", root)));
    writeFileSync(join(root, "config/app.json"), JSON.stringify({ timeout: e.timeout }));
    assert(pass(checks("sandbox-small-edit", root)));
    writeFileSync(join(root, "config/app.json"), "{bad json");
    assert(!pass(checks("sandbox-small-edit", root)));
  });
  assert(judge("no_delegation", facts({ delegatedCount: 0 })));
  assert(!judge("no_delegation", facts()));
});
test("duplicate oracle requires a final and keeps exactly one un-reverted install sequence", () => {
  assert(!judge("no_duplicate", facts({ leadFinalReplyAtMs: null, leadFinalReplyText: "" })));
  assert(!judge("no_duplicate", facts({ delegationsPerArtifact: { "docs/usage.md": 2 } })));
  withFixture("sandbox-duplicate", (root, { expected: e }) => {
    assert(pass(checks("sandbox-duplicate", root)));
    const file = join(root, e.artifact),
      original = readFileSync(file, "utf8");
    writeFileSync(file, original + original);
    assert(!pass(checks("sandbox-duplicate", root)));
    writeFileSync(file, original.replace("Node 22", "Node 18"));
    assert(!pass(checks("sandbox-duplicate", root)));
  });
});

function evidenceFixture(root) {
  const file = join(root, "session.jsonl");
  const message = (role, content, extra = {}) => ({
    type: "message",
    timestamp: "2026-01-01T00:00:01Z",
    message: { role, content, ...extra },
  });
  const entries = [
    message("user", '{"channel":"sprout_turn_context","runId":"lead-run"}\n\nTask'),
    message("assistant", [
      {
        type: "toolCall",
        name: "sprout_delegation_start",
        arguments: { workerProfileId: "one", request: "Review docs/usage.md" },
      },
      {
        type: "toolCall",
        name: "sprout_delegation_start",
        arguments: { workerProfileId: "two", request: "Review docs/usage.md" },
      },
    ]),
    message("assistant", [{ type: "text", text: "Verified docs/usage.md" }], {
      stopReason: "stop",
      usage: { totalTokens: 7 },
    }),
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return {
    entries,
    e: {
      delegations: [
        { workerProfileId: "one", requestSummary: "Review docs/usage.md" },
        { workerProfileId: "two", requestSummary: "Review docs/usage.md" },
      ],
      events: [],
      runs: [
        {
          id: "lead-run",
          chatId: "lead",
          status: "completed",
          assistantMessageId: "answer",
          startedAt: 1,
          configSnapshot: {
            sessionFile: file,
            profile: { id: "lead-profile" },
            tools: ["read", "bash"],
            resources: { systemPromptChars: 100, inheritHostResources: false },
          },
        },
      ],
    },
  };
}
test("transcript binding and artifact duplication across different worker profiles", () => {
  withFixture("sandbox-duplicate", (root) => {
    const { e, entries } = evidenceFixture(root);
    assert.equal(assistantMessagesByRun(entries).get("lead-run").length, 2);
    const f = factsFrom(e, "lead", ["docs/usage.md"]);
    assert.equal(f.delegationsPerArtifact["docs/usage.md"], 2);
    assert.equal(f.runs[0].systemPromptChars, 100);
    assert.deepEqual(f.runs[0].availableTools, ["read", "bash"]);
    assert(!judge("no_duplicate", { ...f, artifactAssertions: [{ exitCode: 0 }] }));
    for (const delegation of e.delegations) delegation.requestSummary = "Review installation";
    for (const [index, tool] of entries[1].message.content.entries()) {
      tool.arguments.request = "Review installation";
      tool.arguments.resources = [{ path: index === 0 ? "docs/usage.md" : "docs" }];
    }
    writeFileSync(
      e.runs[0].configSnapshot.sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    assert.equal(
      factsFrom(e, "lead", ["docs/usage.md"]).delegationsPerArtifact["docs/usage.md"],
      2,
    );
    entries.push(
      {
        type: "message",
        message: {
          role: "user",
          content: '{"channel":"sprout_turn_context","runId":"later-run"}\n\nContinue',
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { totalTokens: 2 },
          content: [{ type: "text", text: "Latest final only." }],
        },
      },
    );
    writeFileSync(
      e.runs[0].configSnapshot.sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    e.runs.push({ ...e.runs[0], id: "later-run" });
    assert.equal(factsFrom(e, "lead", []).leadFinalReplyText, "Latest final only.");
  });
});
test("observed prompt hashes bind to the actual run, even when workers share a model", () => {
  const request = (runId, system) => ({
    model: "shared-model",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: JSON.stringify({ channel: "sprout_turn_context", runId }) + "\n\nTask",
      },
    ],
  });
  const a = systemPromptEvidence(request("worker-one", "aaa"));
  const b = systemPromptEvidence(request("worker-two", "bbb"));
  assert.equal(a.runId, "worker-one");
  assert.equal(b.runId, "worker-two");
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.hash, systemPromptEvidence(request("different-run", "aaa")).hash);
  assert.equal(systemPromptEvidence({ messages: [{ role: "system", content: "aaa" }] }), null);
});

test("aborted settles but is unmeasured and cannot pass any oracle", () => {
  const runs = [{ status: "aborted" }];
  assert(settled({ runs, events: [], delegations: [] }));
  assert.equal(classifyRuns(runs), "aborted");
  for (const task of tasks) assert(!judge(task.oracle, facts({ runs })));
});

const run = (role = "lead", hash = "a".repeat(64)) => ({
  status: "completed",
  role,
  systemPromptChars: 10,
  availableTools: ["read", "bash"],
  inheritHostResources: false,
  systemPromptHashes: [hash],
});
const pair = () => [
  {
    arm: "A",
    task: "t",
    repeat: 1,
    head: "a".repeat(40),
    status: "passed",
    passed: true,
    runs: [run()],
  },
  {
    arm: "B",
    task: "t",
    repeat: 1,
    head: "b".repeat(40),
    status: "failed",
    passed: false,
    runs: [{ ...run("lead", "b".repeat(64)), systemPromptChars: 20 }],
  },
];
test("comparison rejects equal commits, same hashes, missing fields and tool mismatches by role", () => {
  assert.deepEqual(comparisonReasons(pair(), { dry: true }), []);
  for (const patch of [
    { head: "a".repeat(40) },
    { runs: [run()] },
    { runs: [] },
    { status: "not_run", passed: null },
    { runs: [{ ...run(), systemPromptChars: null }] },
    { runs: [{ ...run(), availableTools: null }] },
    { runs: [{ ...run(), availableTools: ["read"] }] },
    { runs: [{ ...run(), systemPromptHashes: null }] },
    { runs: [{ ...run(), inheritHostResources: true }] },
  ]) {
    const rows = pair();
    rows[1] = { ...rows[1], ...patch };
    assert(comparisonReasons(rows, { dry: true }).length > 0, JSON.stringify(patch));
  }
  const rows = pair();
  rows[0].runs.push({ ...run("worker", "c".repeat(64)), availableTools: ["worker_only"] });
  rows[1].runs.push({
    ...run("worker", "d".repeat(64)),
    systemPromptChars: 30,
    availableTools: ["worker_only"],
  });
  assert.deepEqual(comparisonReasons(rows, { dry: true }), []);
});
test("batch plan alternates arms and all anomalies stay outside denominator", () => {
  const plan = planBatch(
    [
      { arm: "A", ref: "x" },
      { arm: "B", ref: "y" },
    ],
    tasks,
    2,
  );
  assert.equal(plan.length, 24);
  assert.deepEqual(
    plan.slice(0, 4).map((x) => x.arm),
    ["A", "B", "A", "B"],
  );
  assert.deepEqual(
    plan.slice(12, 16).map((x) => x.arm),
    ["B", "A", "B", "A"],
  );
  const rows = pair();
  for (const status of ["aborted", "interrupted", "timeout", "errored", "not_run"])
    rows.push({ arm: "A", task: "t", status, passed: null });
  const summary = summarize(rows, { dry: true });
  const a = summary.groups.find((g) => g.group === "A / ALL");
  assert.equal(a.planned, 6);
  assert.equal(a.attempted, 5);
  assert.equal(a.completed, 1);
  assert.equal(a.passed, 1);
  assert.equal(a.failed, 0);
  for (const status of ["aborted", "interrupted", "timeout", "errored", "not_run"])
    assert.equal(a[status], 1);
  assert(summary.reasons.some((r) => r.includes("incomplete")));
});
