import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsFrom } from "./evidence.mjs";
import { finalizeVerdict } from "./core.mjs";
import { costMetricsFrom, pairedCostRows } from "./cost-metrics.mjs";

function evidence() {
  const input = {
    delegations: [
      { requestSummary: "Fix utils/format.js" },
      { requestSummary: "probe: read-only inspection" },
    ],
    transcript: [
      {
        runId: "lead-1",
        role: "lead",
        tools: [
          { name: "sleep", arguments: { ms: 540 } },
          { name: "sleep", arguments: { ms: 20 } },
          { name: "read", arguments: { path: "unassigned.txt" } },
          { name: "sprout_delegation_start", arguments: {} },
          { name: "sprout_delegation_start", arguments: {} },
          { name: "sprout_delegation_start", arguments: {} },
        ],
      },
      {
        runId: "worker-1",
        role: "worker",
        tools: [
          { name: "sprout_remote_file_write", arguments: { path: "/tmp/repo/utils/format.js" } },
          { name: "write", arguments: { path: "scratch.txt" } },
          { name: "edit", arguments: { path: "scratch.txt" } },
          { name: "write", arguments: { path: "format.js" } },
        ],
      },
    ],
    toolNames: {
      "lead-1": ["sleep", "read", "sprout_delegation_start"],
      "worker-1": ["sprout_remote_file_write", "write", "edit"],
    },
    timings: [
      { role: "lead", startedAt: "2026-11-16T00:00:00Z", settledAt: "2026-11-16T00:00:02Z" },
      { role: "lead", startedAt: "2026-11-16T00:00:03Z", settledAt: "2026-11-16T00:00:04Z" },
      { role: "worker", startedAt: "2026-11-16T00:00:01Z", settledAt: "2026-11-16T00:00:04Z" },
    ],
  };
  for (const run of input.transcript) for (const call of run.tools) call.isError = false;
  return input;
}

test("counts actual delegations, unique explicit writes, lead sleep milliseconds and each role", () => {
  assert.deepEqual(costMetricsFrom(evidence()), {
    delegations: 2,
    probeDelegations: 1,
    unmappedArtifacts: 2,
    leadWallMs: 3000,
    workerWallMs: 3000,
    sleepMsTotal: 560,
    toolCallsByRole: { lead: 6, worker: 4 },
  });
});

test("missing evidence is null, while observed empty calls and delegations are zero", () => {
  assert.deepEqual(costMetricsFrom(), {
    delegations: null,
    probeDelegations: null,
    unmappedArtifacts: null,
    leadWallMs: null,
    workerWallMs: null,
    sleepMsTotal: null,
    toolCallsByRole: { lead: null, worker: null },
  });
  const input = evidence();
  input.delegations = [];
  input.transcript = [{ runId: "lead-1", role: "lead", tools: [] }];
  const result = costMetricsFrom(input);
  assert.equal(result.delegations, 0);
  assert.equal(result.probeDelegations, 0);
  assert.equal(result.unmappedArtifacts, 0);
  assert.equal(result.sleepMsTotal, 0);
  assert.deepEqual(result.toolCallsByRole, { lead: 0, worker: null });
});

test("partial transcripts, missing tool surfaces and unfinished clocks do not fabricate zero", () => {
  const input = evidence();
  input.transcript[1].tools = null;
  delete input.toolNames["lead-1"];
  input.timings[1].settledAt = null;
  input.timings[2].settledAt = "2026-11-15T00:00:00Z";
  input.delegations.push({});
  assert.deepEqual(costMetricsFrom(input), {
    delegations: 3,
    probeDelegations: null,
    unmappedArtifacts: null,
    leadWallMs: null,
    workerWallMs: null,
    sleepMsTotal: null,
    toolCallsByRole: { lead: null, worker: null },
  });
});

test("invalid sleep arguments and opaque nested writes/sleeps remain unknown", () => {
  const input = evidence();
  input.transcript[0].tools[0].arguments.ms = "540";
  assert.equal(costMetricsFrom(input).sleepMsTotal, null);
  input.toolNames["lead-1"].push("codemode");
  input.transcript[0].tools = [
    {
      name: "codemode",
      arguments: { code: "await tools.sleep({ms: 1}); await tools.write({path: target})" },
    },
  ];
  const result = costMetricsFrom(input);
  assert.equal(result.sleepMsTotal, null);
  assert.equal(result.unmappedArtifacts, null);
  assert.equal(result.toolCallsByRole.lead, 1);
});

test("failed writes are excluded, unfinished writes are unknown, and request filenames map exactly", () => {
  const input = evidence();
  input.delegations[0].requestSummary += " and format.js";
  input.transcript[1].tools[1].isError = true;
  input.transcript[1].tools[2].isError = true;
  assert.equal(costMetricsFrom(input).unmappedArtifacts, 0);
  input.transcript[1].tools[2].isError = null;
  assert.equal(costMetricsFrom(input).unmappedArtifacts, null);
});

test("ledger reads bound transcript calls and results without charging another run", () => {
  const directory = mkdtempSync(join(tmpdir(), "crew-cost-test-"));
  try {
    const file = join(directory, "session.jsonl");
    const context = (runId) => ({
      type: "message",
      message: { role: "user", content: JSON.stringify({ channel: "sprout_turn_context", runId }) },
    });
    writeFileSync(
      file,
      [
        context("earlier"),
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "old", name: "sleep", arguments: { ms: 999 } }],
          },
        },
        context("lead-1"),
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "sleep-1", name: "sleep", arguments: { ms: 40 } },
              { type: "toolCall", id: "write-1", name: "write", arguments: { path: "notes.txt" } },
              { type: "toolCall", id: "write-2", name: "write", arguments: { path: "failed.txt" } },
            ],
          },
        },
        { type: "message", message: { role: "toolResult", toolCallId: "write-1", isError: false } },
        { type: "message", message: { role: "toolResult", toolCallId: "write-2", isError: true } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const facts = factsFrom(
      {
        delegations: [],
        events: [],
        runs: [
          {
            id: "lead-1",
            chatId: "chat",
            status: "interrupted",
            startedAt: "2026-11-16T00:00:00Z",
            settledAt: "2026-11-16T00:00:02Z",
            configSnapshot: { sessionFile: file, tools: ["sleep", "write"] },
          },
        ],
      },
      "chat",
    );
    Object.assign(facts, { oracle: "no_delegation", status: "interrupted", passed: null });
    finalizeVerdict(facts);
    assert.equal(facts.probeDelegations, 0);
    assert.deepEqual(facts.probeDelegationEvidence, []);
    assert.equal(facts.delegations, 0);
    assert.equal(facts.sleepMsTotal, 40);
    assert.equal(facts.unmappedArtifacts, 1);
    assert.equal(facts.leadWallMs, 2000);
    assert.equal(facts.workerWallMs, null);
    assert.deepEqual(facts.toolCallsByRole, { lead: 3, worker: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cost table pairs arms by task and repeat without converting missing values to zero", () => {
  const rows = pairedCostRows([
    { task: "two", repeat: 1, arm: "B", delegations: 0 },
    { task: "one", repeat: 1, arm: "A" },
    { task: "two", repeat: 1, arm: "A", delegations: 2 },
    { task: "two", repeat: 2, arm: "B" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.task),
    ["two #1 / A", "two #1 / B", "one #1 / A", "two #2 / B"],
  );
  assert.equal(rows[0].delegations, 2);
  assert.equal(rows[1].delegations, 0);
  assert.equal(rows[2].delegations, null);
  assert.equal(rows[0].sleepMsTotal, null);
});
