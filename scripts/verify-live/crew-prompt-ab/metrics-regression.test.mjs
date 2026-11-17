import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsFrom } from "./evidence.mjs";
import { evaluateOracle, finalizeVerdict, comparisonReasons } from "./core.mjs";
import { rejudgeRow } from "./rejudge.mjs";

const iso = (ms) => new Date(Date.UTC(2026, 10, 17) + ms).toISOString();
function delivery() {
  return {
    oracle: "worker_takes_minutes", status: "failed",
    oracleConfig: { delegationCount: 1, minWorkerMs: 180000, maxSleepMs: 500, leadBudgetMs: 90000 },
    delegatedCount: 1, requiredDelegationArtifacts: ["report.json"],
    delegationEvidence: [{ status: "completed", requestArtifacts: ["report.json"], workerArtifacts: ["report.json"] }],
    workerReportedComplete: [true], completeEventTimes: [Date.parse(iso(300000))],
    leadFinalReplyAtMs: Date.parse(iso(350000)), leadFinalReplyText: "Done",
    artifactAssertions: [{ exitCode: 0 }], sleepMsTotal: 0,
    runs: [{ role: "lead", status: "completed", startedAt: iso(0), settledAt: iso(349000), tools: [] }],
    workerRuns: [{ runId: "worker", status: "completed", startedAt: iso(1000), settledAt: iso(235000) }],
  };
}
function withSnapshot(t) {
  const directory = mkdtempSync(join(tmpdir(), "crew-metrics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "session.jsonl");
  const entries = [];
  const turn = (id, calls) => {
    entries.push({ type: "message", message: { role: "user", content: JSON.stringify({ channel: "sprout_turn_context", runId: id }) } });
    entries.push({ type: "message", timestamp: iso(10000), message: { role: "assistant", usage: { totalTokens: 10 }, content: calls.map((call, index) => ({ type: "toolCall", id: `${id}-${index}`, ...call })) } });
    calls.forEach((call, index) => entries.push({ type: "message", message: { role: "toolResult", toolCallId: `${id}-${index}`, isError: call.name === "given" } }));
  };
  turn("unrelated", [{ name: "sleep", arguments: { ms: 999999 } }]);
  turn("lead-1", [
    { name: "sleep", arguments: { ms: 120000 } },
    { name: "sleep", arguments: { ms: 110000 } },
    { name: "given", arguments: {} },
  ]);
  turn("lead-2", [{ name: "read", arguments: { path: "report.json" } }]);
  turn("worker", []);
  writeFileSync(file, entries.map(JSON.stringify).join("\n") + "\n");
  const run = (id, chatId, start, end) => ({ id, chatId, status: "completed", startedAt: iso(start), settledAt: iso(end), configSnapshot: { sessionFile: file, tools: ["read", "sleep"] } });
  const evidence = { delegations: [], events: [], runs: [run("lead-1", "chat", 0, 329000), run("lead-2", "chat", 480000, 500000), run("worker", "child", 17000, 280000)] };
  writeFileSync(join(directory, "domain-evidence.json"), JSON.stringify(evidence));
  return { directory, file, evidence };
}

test("shared transcript counts each bound run once, including rejected unknown-tool attempts", (t) => {
  const { evidence } = withSnapshot(t);
  const facts = factsFrom(evidence, "chat");
  assert.equal(facts.toolCallsByRole.lead, 4);
  assert.equal(facts.sleepMsTotal, 230000);
  assert.equal(facts.unmappedArtifacts, 0);
  assert.equal(facts.leadWallMs, 349000);
  assert.equal(facts.workerWallMs, 263000);
});

test("ISO worker spans are measurable and corrected wait budget measures actions, not elapsed waiting", () => {
  for (const duration of [263000, 224000, 234000]) {
    const facts = delivery();
    facts.workerRuns[0].settledAt = iso(1000 + duration);
    const registered = evaluateOracle(facts.oracle, facts);
    const corrected = evaluateOracle(facts.oracle, facts, { corrected: true });
    assert.equal(registered.gates.eventDrivenWait.actual.leadMs, 349000);
    assert.equal(registered.gates.eventDrivenWait.checks.leadBudget, false);
    assert.equal(corrected.gates.eventDrivenWait.checks.genuinelyLongWorker, true);
    assert.deepEqual(corrected.gates.eventDrivenWait.actual.workerMs, [duration]);
    assert.equal(corrected.gates.eventDrivenWait.checks.leadActionBudget, true);
    assert.equal(corrected.passed, true);
  }
});

test("missing measurements stay unknown with reasons; observed violations remain false", () => {
  const facts = delivery();
  facts.sleepMsTotal = null;
  facts.runs[0].startedAt = null;
  facts.workerRuns[0].settledAt = null;
  const result = evaluateOracle(facts.oracle, facts, { corrected: true });
  const wait = result.gates.eventDrivenWait;
  assert.equal(wait.checks.sleepObserved, null);
  assert.equal(wait.checks.genuinelyLongWorker, null);
  assert.equal(wait.actual.leadMs, null);
  assert.match(wait.actual.leadMsReason, /timing evidence/);
  assert.match(wait.actual.sleepMsTotalReason, /evidence/);
  assert.match(wait.actual.workerMsReason, /timing evidence/);
  assert.equal(result.passed, null);
  assert.deepEqual(result.failedGates, []);
  assert.deepEqual(result.unmeasuredGates, ["eventDrivenWait"]);
  finalizeVerdict(facts);
  assert.equal(facts.verdictCorrected.outcome, "unmeasured");
  assert.equal(facts.verdictCorrected.evaluated, false);
  assert.equal(facts.status, "unmeasured");
  assert.equal(facts.passed, null);
  assert(comparisonReasons([facts]).includes("unmeasured oracle gates"));
  facts.sleepMsTotal = 501;
  assert.equal(evaluateOracle(facts.oracle, facts, { corrected: true }).passed, false);
});

test("wait queries count only after dispatch and before receipt, with unknown timestamps kept unknown", () => {
  const facts = delivery();
  const list = (atMs) => ({ name: "sprout_delegation_list", atMs });
  facts.runs[0].tools = [
    list(iso(100)),
    { name: "sprout_delegation_start", atMs: Date.parse(iso(200)) },
    list(iso(300)),
    list(iso(300001)),
  ];
  const wait = () => evaluateOracle(facts.oracle, facts, { corrected: true }).gates.eventDrivenWait;
  assert.equal(wait().actual.queries, 1);
  assert.equal(wait().passed, true);
  facts.runs[0].tools[2].atMs = null;
  assert.equal(wait().actual.queries, null);
  assert.equal(wait().checks.noRepeatedQueries, null);
  assert.match(wait().actual.queriesReason, /timing evidence/);
  facts.runs[0].tools = [];
  facts.runs[0].transcriptObserved = false;
  assert.equal(wait().actual.queries, null);
});

test("offline rejudge rebuilds stale metrics from raw shared transcript and audits it once", (t) => {
  const { directory, file, evidence } = withSnapshot(t);
  const facts = delivery();
  Object.assign(facts, {
    evidenceDirectory: directory, sleepMsTotal: null, unmappedArtifacts: null,
    toolCallsByRole: { lead: null, worker: null },
    runs: evidence.runs.map((r) => ({ runId: r.id, chatId: r.chatId, role: r.chatId === "chat" ? "lead" : "worker", tools: [] })),
  });
  const before = structuredClone(facts);
  const result = rejudgeRow(facts);
  assert.equal(result.toolCallsByRole.lead, 4);
  assert.equal(result.sleepMsTotal, 230000);
  assert.equal(result.unmappedArtifacts, 0);
  assert.equal(result.verdictCorrected.gates.eventDrivenWait.actual.leadMs, 349000);
  assert.equal(result.rejudge.evidence.filter((e) => e.path === file).length, 1);
  assert.deepEqual(facts, before);
});
