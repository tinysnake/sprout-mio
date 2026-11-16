import assert from "node:assert/strict";
import test from "node:test";
import { settled, readEvidence } from "./evidence.mjs";
import * as core from "./core.mjs";

test("blocked worker and completed lead settle despite non-delivered dispatch bookkeeping", () => {
  const evidence = {
    runs: [{ status: "completed" }, { status: "completed" }, { status: "completed" }],
    delegations: [{ id: "dlg_one", status: "blocked", terminalAt: null }],
    events: [
      { delegationId: "dlg_one", kind: "blocked", deliveryState: "acknowledged" },
      { delegationId: "dlg_one", kind: "dispatched", deliveryState: "pending" },
    ],
  };
  assert.equal(settled(evidence), true);
  assert.equal(settled({ ...evidence, runs: [{ status: "running" }] }), false);
  assert.equal(settled({ ...evidence, delegations: [{ status: "running" }] }), false);
  assert.equal(
    settled({ ...evidence, events: [{ kind: "blocked", deliveryState: "pending" }] }),
    false,
  );
});

test("probe timeout recovers a full emitted snapshot and classifies the probe independently", () => {
  const snapshot = { runs: [], delegations: [], events: [] };
  const source = `console.log(${JSON.stringify(JSON.stringify(snapshot))}); setInterval(() => {}, 1000);`;
  const evidence = readEvidence(process.env, {}, 400, source);
  assert.deepEqual(evidence.runs, []);
  assert.equal(evidence.evidenceProbe.status, "timeout");
  assert.match(evidence.evidenceProbe.reason, /ETIMEDOUT/);
  assert.throws(() => readEvidence(process.env, {}, 400, "setInterval(() => {}, 1000)"), {
    code: "AB_EVIDENCE_PROBE_TIMEOUT",
  });
});

test("probe failure after judgment preserves either measured verdict with a separate diagnostic", () => {
  for (const passed of [true, false]) {
    const row = { status: passed ? "passed" : "failed", passed };
    const error = Object.assign(new Error("domain evidence probe exceeded its budget"), {
      code: "AB_EVIDENCE_PROBE_TIMEOUT",
    });
    core.recordTaskError(row, error);
    assert.equal(row.passed, passed);
    assert.equal(row.status, passed ? "passed" : "failed");
    assert.equal(row.evidenceProbe.status, "timeout");
    assert.match(row.evidenceProbe.reason, /budget/);
    core.recordTaskError(row, new Error("unrelated late exception"));
    assert.equal(row.passed, passed);
    assert.equal(row.status, passed ? "passed" : "failed");
  }
  const row = { status: "running", passed: null };
  core.recordTaskError(
    row,
    Object.assign(new Error("probe timeout"), { code: "AB_EVIDENCE_PROBE_TIMEOUT" }),
  );
  assert.equal(row.status, "timeout");
  assert.equal(row.passed, null);
});
