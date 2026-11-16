import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { taskSet, judge, seedFixture } from "./core.mjs";
import { assistantMessagesByRun, settled } from "./evidence.mjs";

test("transcript evidence binds to runId even when resumed runs start in the same second", () => {
  const user = (id) => ({
    type: "message",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify({ channel: "sprout_turn_context", runId: id }) + "\n\nTask",
        },
      ],
    },
  });
  const assistant = {
    type: "message",
    timestamp: "2026-11-16T00:00:00.500Z",
    message: { role: "assistant", usage: { totalTokens: 12 }, content: [] },
  };
  const result = assistantMessagesByRun([user("run_one"), assistant, user("run_two"), assistant]);
  assert.equal(result.get("run_one").length, 1);
  assert.equal(result.get("run_two").length, 1);
  assert.throws(() => assistantMessagesByRun([assistant]), /persisted run binding/);
});
test("settle waits for durable deliveries and cancellation to finish", () => {
  const evidence = {
    runs: [{ status: "completed" }],
    delegations: [{ status: "completed" }],
    events: [{ deliveryState: "acknowledged" }],
  };
  assert.equal(settled(evidence), true);
  for (const state of ["pending", "bound", "injected"])
    assert.equal(settled({ ...evidence, events: [{ deliveryState: state }] }), false);
  assert.equal(settled({ ...evidence, delegations: [{ status: "canceling" }] }), false);
});

const base = {
  delegatedCount: 1,
  distinctWorkerProfiles: ["worker-one"],
  delegationsPerWorker: { "worker-one": 1 },
  workerRunTerminalStatuses: ["completed"],
  workerReportedComplete: [true],
  completeEventTimes: [100],
  leadFinalReplyAtMs: 101,
  fixtureChangeObserved: true,
};
test("delegation oracles require completion receipts and causal lead reply order", () => {
  assert.equal(judge("delegate_confirmed", base), true);
  assert.equal(judge("delegate_confirmed", { ...base, leadFinalReplyAtMs: 100 }), false);
  assert.equal(judge("delegate_confirmed", { ...base, workerReportedComplete: [false] }), false);
  assert.equal(
    judge("delegate_confirmed", { ...base, workerRunTerminalStatuses: ["failed"] }),
    false,
  );
  assert.equal(judge("worker_finishes", base), true);
  assert.equal(
    judge("worker_finishes", { ...base, workerRunTerminalStatuses: ["aborted"] }),
    false,
  );
  const parallel = {
    ...base,
    delegatedCount: 2,
    distinctWorkerProfiles: ["one", "two"],
    workerRunTerminalStatuses: ["completed", "completed"],
    workerReportedComplete: [true, true],
    completeEventTimes: [99, 100],
  };
  assert.equal(judge("delegate_parallel", parallel), true);
  assert.equal(judge("delegate_parallel", { ...parallel, distinctWorkerProfiles: ["one"] }), false);
  assert.equal(judge("delegate_parallel", { ...parallel, leadFinalReplyAtMs: 99 }), false);
});
test("negative oracles distinguish an answer, a real file change, and duplicate dispatch", () => {
  const none = {
    ...base,
    delegatedCount: 0,
    distinctWorkerProfiles: [],
    delegationsPerWorker: {},
    workerRunTerminalStatuses: [],
    workerReportedComplete: [],
    completeEventTimes: [],
  };
  assert.equal(judge("no_delegation", none), true);
  assert.equal(judge("no_delegation", { ...none, leadFinalReplyAtMs: null }), false);
  assert.equal(judge("no_delegation", base), false);
  assert.equal(judge("no_delegation_but_work_done", none), true);
  assert.equal(
    judge("no_delegation_but_work_done", { ...none, fixtureChangeObserved: false }),
    false,
  );
  assert.equal(judge("no_duplicate", base), true);
  assert.equal(judge("no_duplicate", { ...base, delegationsPerWorker: { one: 2 } }), false);
});
test("plan is the sole task source and every referenced sandbox exists", () => {
  const tasks = taskSet(resolve("docs/plans/crew-prompt-ab.md"));
  assert.equal(tasks.length, 6);
  const dir = mkdtempSync(join(tmpdir(), "crew-ab-fixtures-"));
  for (const task of tasks) {
    const root = join(dir, task.fixture);
    mkdirSync(root);
    assert(Object.keys(seedFixture(task.fixture, root)).length > 0);
  }
  assert.match(readFileSync(join(dir, "sandbox-fix/utils/format.js"), "utf8"), /Math.floor/);
});
function run(env) {
  return new Promise((done, reject) => {
    const child = spawn("bash", ["scripts/verify-live/crew-prompt-ab.sh"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, output });
    });
  });
}
test("missing explicit model fails before creating artifacts", async () => {
  const directory = join(tmpdir(), `crew-ab-no-model-${Date.now()}`),
    out = join(directory, "out.jsonl");
  const result = await run({
    AB_MODEL: "",
    SPROUT_VERIFY_PI_MODEL: "",
    AB_DRY: "1",
    AB_REF: "HEAD",
    AB_OUT: out,
  });
  assert.equal(result.code, 2, result.output);
  assert(!existsSync(directory));
});
test(
  "AB_DRY runs a real Crew through the local endpoint and appends a judged row",
  { timeout: 610000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-ab-dry-test-"));
    const out = join(dir, "result.jsonl");
    const result = await run({
      AB_DRY: "1",
      AB_REF: process.env.AB_TEST_REF ?? "HEAD",
      AB_ARM: "dry-test",
      AB_MODEL: "sprout-verify-local/chat-owner",
      AB_TASKS: "donot-delegate-question",
      AB_REPEAT: "1",
      AB_TASK_TIMEOUT_MS: "120000",
      AB_OUT: out,
    });
    assert.equal(result.code, 0, result.output);
    const rows = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.status, "passed");
    assert.equal(row.passed, true);
    assert.equal(row.delegatedCount, 0);
    assert.match(row.head, /^[0-9a-f]{40}$/);
    assert.equal(row.oracle, "no_delegation");
    assert.equal(row.modelFixture.paidModelCalls, 0);
    assert.equal(row.modelFixture.failed, false);
    assert(row.modelFixture.requestCount > 0);
    assert.equal(row.childProcesses.length, 3);
    assert(row.childProcesses.every((child) => child.exitCode === 0));
    assert(
      row.runs.some(
        (r) => r.startedAt && r.transcript && r.tokens !== null && r.sdkVersion !== "protocol-stub",
      ),
    );
    for (const name of ["prepare", "startup", "sendTask", "settle", "judge"])
      assert(Number.isFinite(row.wallClockPerPhase[name]));
    console.log(`DRY ledger ${out}`);
  },
);
