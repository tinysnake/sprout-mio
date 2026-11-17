import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixture } from "./fixtures.mjs";
import { artifactAssertions } from "./artifacts.mjs";
import { createSettlementCheck } from "./settlement.mjs";
import { settled } from "./evidence.mjs";
import { forbiddenDelegation, preserveOutcome, judge, evaluateOracle } from "./core.mjs";

for (const oracle of ["no_delegation", "no_delegation_but_work_done"]) {
  test(`${oracle} waits for runs and a stable settled snapshot before failing`, () => {
    let clock = 0;
    const check = createSettlementCheck({ oracle, now: () => clock });
    const latest = {
      runs: [{ status: "running" }, { status: "queued" }],
      delegations: [{ status: "running" }],
      events: [],
    };
    assert(forbiddenDelegation(oracle, latest.delegations.length));
    assert.equal(settled(latest), false);
    assert.equal(check(latest), false);
    clock = 2000;
    latest.runs[0].status = "completed";
    assert.equal(settled(latest), false);
    assert.equal(check(latest), false);
    latest.runs[1].status = "completed";
    latest.delegations[0].status = "completed";
    assert.equal(settled(latest), true);
    assert.equal(check(latest), false);
    clock += 999;
    assert.equal(check(latest), false);
    latest.finalReply = "Finished the requested edit.";
    assert.equal(check(latest), false, "changed evidence resets stability window");
    clock += 999;
    assert.equal(check(latest), false);
    clock += 1;
    assert.equal(check(latest), true);
    const row = { oracle, delegatedCount: 1, status: "passed", passed: true };
    preserveOutcome(row, oracle, row.delegatedCount);
    assert.equal(row.status, "failed");
    assert.equal(row.violation, "delegation forbidden by task oracle");
  });
}

test("settlement still throws classified terminal failures after forbidden delegation", () => {
  for (const status of ["aborted", "canceled", "timed_out", "failed"]) {
    const check = createSettlementCheck({ oracle: "no_delegation" });
    assert.throws(
      () => check({ runs: [{ status }], delegations: [{ status: "completed" }], events: [] }),
      (error) => error.message.startsWith("agent run terminated ") && !!error.runClassification,
    );
  }
});

function withClones(run) {
  const base = mkdtempSync(join(tmpdir(), "ab-parallel-clones-"));
  const roots = [join(base, "one"), join(base, "two")];
  try {
    for (const root of roots) seedFixture("sandbox-parallel", root);
    const write = (index, file, content) => writeFileSync(join(roots[index], file), content);
    const facts = {
      machineScopes: roots.map((worktree) => ({ worktree })),
      leadFinalReplyText: "Both workers completed the updates and checks.",
    };
    const check = (overrides = {}) =>
      artifactAssertions({ fixture: "sandbox-parallel" }, roots[0], { ...facts, ...overrides })[0];
    run({ roots, write, check, facts });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function splitChanges(write) {
  write(0, "README.md", "Requires Node 22.\n");
  write(0, "config/retry.json", '{"retryCount":0}\n');
  write(1, "README.md", "Requires Node 18.\n");
  write(1, "src/retry.js", "exports.retryCount = 0;\n");
  write(1, "config/retry.json", '{ "retryCount": 5 }\n');
}

test("parallel passes real split clone contents even when lead names no paths", () => {
  withClones(({ write, check }) => {
    splitChanges(write);
    const result = check();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      check({ leadFinalReplyText: "src/retry.js: 30; config/retry.json: 50" }).exitCode,
      0,
    );
    const facts = {
      runs: [{ role: "lead", status: "completed" }],
      requiredDelegationArtifacts: ["README.md", "config/retry.json"],
      artifactAssertions: [result],
      leadFinalReplyText: "Both workers completed the updates and checks.",
      leadFinalReplyAtMs: 30,
      delegatedCount: 2,
      distinctWorkerProfiles: ["one", "two"],
      workerRunTerminalStatuses: ["completed", "completed"],
      workerReportedComplete: [true, true],
      completeEventTimes: [20, 21],
      delegationEvidence: [
        { workerProfileId: "one", requestArtifacts: ["README.md"], workerArtifacts: ["README.md"] },
        {
          workerProfileId: "two",
          requestArtifacts: ["config/retry.json"],
          workerArtifacts: ["config/retry.json"],
        },
      ],
    };
    assert(judge("delegate_parallel", facts), "no path naming gate remains in judge");
    facts.reportSignals = { leadNamesNodeLine: false, retryFiles: [] };
    assert(
      evaluateOracle("delegate_parallel", facts, { corrected: true }).passed,
      "corrected gates also ignore report signals",
    );
  });
});

test("parallel rejects an untouched clone even though its seeded retry counts are correct", () => {
  withClones(({ write, check }) => {
    write(0, "README.md", "Requires Node 22.\n");
    const result = check({ leadFinalReplyText: "src/retry.js: 3\nconfig/retry.json: 5" });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /each clone has a changed expected artifact/);
  });
});

for (const [file, wrong] of [
  ["README.md", "Requires Node 18.\n"],
  ["src/retry.js", "exports.retryCount = 30;\n"],
  ["config/retry.json", '{"retryCount":50}\n'],
]) {
  test(`parallel rejects missing expected content in both clones: ${file}`, () => {
    withClones(({ write, check }) => {
      splitChanges(write);
      for (const i of [0, 1]) write(i, file, wrong);
      const result = check({ leadFinalReplyText: "src/retry.js: 3\nconfig/retry.json: 5" });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /README Node version line|retry count/);
    });
  });
}

test("parallel rejects stale Node lines and duplicate clone scopes", () => {
  withClones(({ roots, write, check }) => {
    splitChanges(write);
    write(0, "README.md", "Requires Node 22.\nRequires Node 18.\n");
    assert.equal(check().exitCode, 1);
    write(0, "README.md", "Requires Node 22.\n");
    assert.equal(
      check({ machineScopes: [{ worktree: roots[0] }, { worktree: roots[0] }] }).exitCode,
      1,
    );
    assert.equal(check({ machineScopes: [] }).exitCode, 1);
  });
});
