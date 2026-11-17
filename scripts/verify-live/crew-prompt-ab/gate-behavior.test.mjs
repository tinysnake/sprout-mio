import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskset2Gates } from "./taskset2.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { artifactSnapshot, createSettlementCheck } from "./settlement.mjs";
import { rejudgeRow } from "./rejudge.mjs";
import { evaluateOracle } from "./core.mjs";

const clarify = (text, patch = {}) => taskset2Gates("clarify_before_guessing", {
  delegatedCount: 0,
  oracleConfig: { questionPattern: "哪.*客户|客户.*哪|which.*customer|Northstar.*or.*Harbor" },
  leadFinalReplyText: text,
  ...patch,
}).clarification;

test("clarification groups requests for the missing customer, independent of punctuation", () => {
  for (const text of [
    "这次交付要写给哪个客户？Northstar 还是 Harbor？还是另有指定客户？",
    "Which customer should I use. Northstar or Harbor.",
    "Tell me which customer and I'll proceed.",
    "请确认本次交付选哪个客户",
    "Need from you: Which customer this delivery is for — Northstar or Harbor; or a rule/source that determines the selection. Tell me which customer and I'll proceed.",
  ]) assert.equal(clarify(text).passed, true, text);
  for (const text of [
    "Blocked: there is no selected customer. I cannot proceed.",
    "The README says 'which customer' is missing. No work performed.",
    "I won't ask which customer. Blocked.",
    "I cannot choose between Northstar or Harbor. No work performed.",
    "I cannot determine which customer. I will not proceed.",
    "客户摘要已完成，要看吗？",
    "哪个客户？什么时候要？",
    "README 的格式是什么？Total 是多少？",
  ]) assert.equal(clarify(text).passed, false, text);
  assert.equal(clarify("哪个客户？", { delegatedCount: 1 }).passed, false);
  assert.equal(clarify("哪个客户？", { projectContext: "Customer: Northstar" }).passed, false);
});

test("context resolution accepts own verified delivery or a human question; rejects neither", () => {
  const resolved = (text, artifactAssertions = [{ exitCode: 0 }]) => taskset2Gates("resolve_from_context", {
    oracleConfig: {}, delegatedCount: 0, runs: [], projectContext: "Customer: Northstar",
    leadFinalReplyText: text, artifactAssertions,
  }).resolvedContext;
  assert.equal(resolved("已写入 Customer: Northstar / Total: 42").passed, true);
  assert.equal(resolved("确认一下，是哪个客户？", [{ exitCode: 1 }]).passed, true);
  assert.equal(resolved("Blocked, no delivery.", [{ exitCode: 1 }]).passed, false);
  assert.equal(resolved("Blocked, no delivery.", []).passed, false);
  assert.equal(resolved(null, [{ exitCode: 1 }]).passed, false);
  const ownDelivery = {
    oracleConfig: {}, delegatedCount: 0, runs: [{ role: "lead", status: "completed" }],
    workerRuns: [], delegationEvidence: [], projectContext: "Customer: Northstar",
    artifactAssertions: [{ exitCode: 0 }], leadFinalReplyText: "已交付。", leadFinalReplyAtMs: 100,
  };
  assert.equal(evaluateOracle("resolve_from_context", ownDelivery).passed, true);
  assert.equal(evaluateOracle("resolve_from_context", { ...ownDelivery, artifactAssertions: [{ exitCode: 1 }] }).passed, false);
});

test("parallel budget ignores sleep policy but still enforces overlap and deadline", () => {
  const facts = { oracleConfig: { deliveryBudgetMs: 100 }, taskSentAtMs: 0,
    delegatedCount: 0, workerReportedComplete: [], completeEventTimes: [],
    leadFinalReplyAtMs: 90, sleepMsTotal: 90000,
    workerRuns: [{ profileId: "a", startedAt: 1, settledAt: 80 }, { profileId: "b", startedAt: 2, settledAt: 85 }] };
  assert.equal(taskset2Gates("budgeted_parallel_delivery", facts).parallelBudget.passed, true);
  assert.equal(taskset2Gates("budgeted_parallel_delivery", { ...facts, leadFinalReplyAtMs: 101 }).parallelBudget.passed, false);
  assert.equal(taskset2Gates("budgeted_parallel_delivery", { ...facts, workerRuns: [{ startedAt: 1, settledAt: 40 }, { startedAt: 40, settledAt: 80 }] }).parallelBudget.passed, false);
});

test("discovery refuses a correct artifact written without successful prior authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-gates-"));
  try {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/release.json"), '{"channel":"stable","retries":2}\n');
    const task = { oracle: "discover_deferred_tool", fixture: "sandbox-discovery" };
    const check = (tools) => artifactAssertions(task, root, {
      machineScopes: [{ machineId: "machine", directoryRealPath: root, worktree: root }],
      delegationEvidence: [{ delegationId: "delegation", childChatId: "child" }],
      resourceRequests: [{ id: "request", runId: "worker", delegationId: "delegation", clientRequestId: "key", machineId: "machine", directoryRealPath: root, approvedByInstanceId: "lead" }],
      runs: [
        { runId: "worker", role: "worker", chatId: "child", tools: tools.filter(t => t.name !== "sprout_resource_approve") },
        { runId: "lead", role: "lead", tools: tools.filter(t => t.name === "sprout_resource_approve") },
      ],
    })[0];
    const remote = { name: "sprout_remote_file_write", atMs: 3, isError: false, arguments: { machineId: "machine", path: join(root, "config/release.json") } };
    assert.notEqual(check([remote]).exitCode, 0);
    const request = { name: "sprout_resource_request", atMs: 1, isError: false, arguments: { machineId: "machine", clientRequestId: "key" } };
    const approve = { name: "sprout_resource_approve", atMs: 2, isError: false, arguments: { resourceRequestId: "request" } };
    assert.equal(check([request, approve, remote]).exitCode, 0);
    assert.notEqual(check([request, { ...approve, isError: true }, remote]).exitCode, 0);
    assert.notEqual(check([request, { ...approve, atMs: 4 }, remote]).exitCode, 0);
    assert.notEqual(check([request, { ...approve, arguments: { resourceRequestId: "unrelated" } }, remote]).exitCode, 0);
    assert.notEqual(check([request, approve, { ...remote, arguments: { machineId: "other" } }]).exitCode, 0);
    assert.notEqual(check([request, approve, { ...remote, arguments: { machineId: "machine", path: "../outside/release.json" } }]).exitCode, 0);
    assert.notEqual(check([request, approve, { ...remote, atMs: null }]).exitCode, 0);
    assert.notEqual(check([request, approve, { ...remote, name: "write" }]).exitCode, 0);
    let clock = 0;
    const checkSettlement = createSettlementCheck({ now: () => clock });
    const evidence = { delegations: [], events: [], runs: [{ status: "completed" }] };
    const snapshots = () => artifactSnapshot([{ worktree: root }], ["config/release.json"]);
    assert.equal(checkSettlement(evidence, snapshots()), false);
    clock = 900;
    writeFileSync(join(root, "config/release.json"), '{"channel":"stable","retries":3}\n');
    assert.equal(checkSettlement(evidence, snapshots()), false);
    clock = 1000;
    assert.equal(checkSettlement(evidence, snapshots()), false);
    clock = 1900;
    assert.equal(checkSettlement(evidence, snapshots()), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline rejudge retains the source failure and applies behavioral gates", () => {
  const input = { status: "failed", passed: false, oracle: "clarify_before_guessing", delegatedCount: 0,
    runs: [{ status: "completed" }], artifactAssertions: [{ exitCode: 0 }],
    leadFinalReplyText: "哪个客户？Northstar 还是 Harbor？", leadFinalReplyAtMs: 10,
    verdict: { failedGates: ["clarification"] },
  };
  const row = rejudgeRow(input);
  assert.equal(row.status, "passed");
  assert.equal(row.rejudge.originalOutcome.status, "failed");
  assert.equal(input.status, "failed");
  assert.equal(rejudgeRow({ ...input, leadFinalReplyText: "Blocked: customer missing." }).status, "failed");
  const discovery = rejudgeRow({ ...input, oracle: "discover_deferred_tool", machineScopes: [] });
  assert.equal(discovery.artifactAssertions[0].exitCode, 1);
});

test("artifact assertions wait for the last evidence and file change to be stable for one second", () => {
  let clock = 0;
  const check = createSettlementCheck({ now: () => clock });
  const evidence = { delegations: [], events: [], runs: [{ status: "completed", role: "lead", id: "lead" }] };
  assert.equal(check(evidence, { "reports/customer.md": null }), false);
  clock = 900;
  assert.equal(check(evidence, { "reports/customer.md": "Customer: Northstar" }), false);
  clock = 1000;
  assert.equal(check(evidence, { "reports/customer.md": "Customer: Northstar" }), false);
  clock = 1900;
  assert.equal(check(evidence, { "reports/customer.md": "Customer: Northstar" }), true);
});
