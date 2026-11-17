import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateOracle, seedFixture, taskSet } from "./core.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { discoveryOracle, discoveryPrompt, discoverySignals } from "./discovery.mjs";

const task = taskSet(new URL("../../../docs/plans/crew-prompt-ab.md", import.meta.url)).find(
  (t) => t.id === "discover-deferred-tool",
);
const call = (name, args = {}) => ({ name, arguments: args, isError: false });
function facts() {
  const worker = {
    runId: "worker-run",
    chatId: "child",
    role: "worker",
    status: "completed",
    tools: [
      call("tool_search", { query: "directory permission" }),
      call("sprout_resource_request", { machineId: "machine", clientRequestId: "request-key" }),
    ],
  };
  const lead = {
    runId: "lead-run",
    role: "lead",
    status: "completed",
    tools: [
      call("tool_search", { query: "approve permission" }),
      call("sprout_resource_approve", { resourceRequestId: "request" }),
    ],
  };
  return {
    delegatedCount: 1,
    delegationEvidence: [{ delegationId: "delegation", childChatId: "child" }],
    machineScopes: [{ machineId: "machine", directoryRealPath: "/workspace" }],
    resourceRequests: [
      {
        id: "request",
        runId: "worker-run",
        delegationId: "delegation",
        clientRequestId: "request-key",
        machineId: "machine",
        directoryRealPath: "/workspace",
        approvedByInstanceId: "lead-instance",
        reason: null,
      },
    ],
    runs: [lead, worker],
    workerRuns: [worker],
    artifactAssertions: [{ name: "machine-file", exitCode: 0 }],
    leadFinalReplyAtMs: 100,
    leadFinalReplyText: "已验收 config/release.json，发布通道 stable，重试次数未变。",
  };
}
const verdict = (f) => evaluateOracle(discoveryOracle, f);

test("discovery: persisted worker request and lead approval pass", () => {
  assert.equal(task.category, "primary");
  assert.equal(verdict(facts()).passed, true);
});

test("discovery: skipping resource request fails even with the correct artifact", () => {
  const f = facts();
  f.resourceRequests = [];
  f.runs[1].tools = [call("tool_search")];
  assert.deepEqual(verdict(f).failedGates, ["resourceAuthorization"]);
});

test("discovery: no tool_search fails even if guessed resource calls succeed", () => {
  const f = facts();
  for (const run of f.runs) run.tools = run.tools.filter((t) => t.name !== "tool_search");
  assert.deepEqual(verdict(f).failedGates, ["discovery"]);
  assert.equal(discoverySignals(f).toolSearchUsed, false);
});

test("discovery: coordinator approval, failed calls and unrelated requests cannot pass", () => {
  for (const mutate of [
    (f) => {
      f.runs[0].tools = [call("tool_search")];
    },
    (f) => {
      f.runs[1].tools[1].isError = true;
    },
    (f) => {
      f.runs[0].tools[1].isError = true;
    },
    (f) => {
      f.resourceRequests[0].approvedByInstanceId = null;
    },
    (f) => {
      f.resourceRequests[0].runId = "other-run";
    },
    (f) => {
      f.resourceRequests[0].machineId = "other-machine";
    },
    (f) => {
      f.resourceRequests[0].directoryRealPath = "/other";
    },
    (f) => {
      f.runs[0].tools[1].arguments.resourceRequestId = "other-request";
    },
  ]) {
    const f = facts();
    mutate(f);
    assert.equal(verdict(f).gates.resourceAuthorization.passed, false);
  }
});

test("discovery: tool-unavailable surrender is not structured business blocking", () => {
  const f = facts();
  f.runs[0].tools = [call("tool_search")];
  f.resourceRequests[0].approvedByInstanceId = null;
  f.runs[1].tools.push(
    call("sprout_delegation_block", {
      reason: "resource_unavailable",
      summary: "找不到工具，放弃申请",
    }),
  );
  assert.equal(verdict(f).gates.resourceAuthorization.passed, false);
  f.resourceRequests[0].reason = "owner_conflict";
  f.runs[1].tools.at(-1).arguments.summary = "request: owner_conflict";
  assert.equal(verdict(f).gates.resourceAuthorization.passed, true);
  f.artifactAssertions[0].exitCode = 1;
  assert.equal(verdict(f).passed, false, "business blocking never waives artifact delivery");
});

test("discovery: missing delegation and unchanged Machine file fail", () => {
  const f = facts();
  f.delegatedCount = 0;
  f.delegationEvidence = [];
  assert.equal(verdict(f).passed, false);
  const root = mkdtempSync(join(tmpdir(), "ab-discovery-"));
  try {
    seedFixture(task.fixture, root);
    const artifactFacts = { machineScopes: [{ worktree: root }] };
    assert.equal(artifactAssertions(task, root, artifactFacts)[0].exitCode, 1);
    writeFileSync(join(root, "config/release.json"), '{"channel":"stable","retries":2}\n');
    assert.equal(artifactAssertions(task, root, artifactFacts)[0].exitCode, 0);
    writeFileSync(join(root, "config/release.json"), '{"channel":"stable","retries":3}\n');
    assert.equal(artifactAssertions(task, root, artifactFacts)[0].exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery: complete requester prompt contains no tool or exposure hints", () => {
  const prompt = discoveryPrompt(task, [
    {
      machineId: "machine",
      directoryRealPath: "/workspace",
      operations: ["shell", "file_read", "file_write"],
      worktree: "/private/fixture",
    },
  ]);
  assert.doesNotMatch(prompt, /tool_search|deferred|sprout_|工具|延迟|fixture|coordinator/i);
  assert.deepEqual(discoverySignals(facts()), {
    toolSearchUsed: true,
    toolSearchCount: 2,
    toolSearchRoles: ["lead", "worker"],
    resourceRequestCalls: 1,
    resourceApproveCalls: 1,
  });
});
