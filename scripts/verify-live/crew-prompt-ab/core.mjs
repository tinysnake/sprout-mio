import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export function taskSet(path) {
  const blocks = [...readFileSync(path, "utf8").matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1, "task source must contain exactly one fenced JSON block");
  const tasks = JSON.parse(blocks[0][1]);
  assert(Array.isArray(tasks) && tasks.length > 0, "nonempty task set");
  const ids = new Set();
  for (const task of tasks) {
    for (const key of ["id", "prompt", "fixture", "oracle"])
      assert.equal(typeof task[key], "string", key);
    assert(!ids.has(task.id), `duplicate task ${task.id}`);
    assert(oracleNames.includes(task.oracle), `unknown oracle ${task.oracle}`);
    ids.add(task.id);
  }
  return tasks;
}
export const unknownEvidence = {
  delegatedCount: null,
  distinctWorkerProfiles: null,
  workerRunTerminalStatuses: null,
  workerReportedComplete: null,
  workerBlocked: null,
  leadFinalReplyAtMs: null,
  firstDelegationTerminalAtMs: null,
  fixtureChangeObserved: null,
  workerRuns: null,
  token: null,
};
export const oracleNames = [
  "delegate_confirmed",
  "delegate_parallel",
  "worker_finishes",
  "no_delegation",
  "no_delegation_but_work_done",
  "no_duplicate",
];
export function judge(name, f) {
  assert(oracleNames.includes(name), `unknown oracle ${name}`);
  const workersDone =
    f.delegatedCount > 0 &&
    f.workerRunTerminalStatuses.length >= f.delegatedCount &&
    f.workerRunTerminalStatuses.every((s) => s === "completed") &&
    f.workerReportedComplete.length === f.delegatedCount &&
    f.workerReportedComplete.every(Boolean);
  const afterComplete =
    f.leadFinalReplyAtMs !== null &&
    f.completeEventTimes.length === f.delegatedCount &&
    f.completeEventTimes.every((t) => f.leadFinalReplyAtMs > t);
  switch (name) {
    case "delegate_confirmed":
      return workersDone && afterComplete;
    case "delegate_parallel":
      return (
        f.delegatedCount === 2 &&
        f.distinctWorkerProfiles.length === 2 &&
        workersDone &&
        afterComplete
      );
    case "worker_finishes":
      return workersDone;
    case "no_delegation":
      return f.delegatedCount === 0 && f.leadFinalReplyAtMs !== null;
    case "no_delegation_but_work_done":
      return f.delegatedCount === 0 && f.fixtureChangeObserved;
    case "no_duplicate":
      return Object.values(f.delegationsPerWorker).every((n) => n <= 1);
  }
}
export function seedFixture(name, root) {
  const fixtures = {
    "sandbox-fix": {
      "package.json": JSON.stringify({
        private: true,
        scripts: { test: "node --test test/*.test.js" },
      }),
      "utils/format.js": "exports.round = value => Math.floor(value * 100) / 100;\n",
      "test/format.test.js":
        "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {round}=require('../utils/format'); test('rounds to nearest hundredth',()=>{assert.equal(round(1.236),1.24);assert.equal(round(2.341),2.34)});\n",
    },
    "sandbox-parallel": {
      "README.md": "# Sandbox\nRequires Node 18.\n",
      "src/retry.js": "exports.retryCount = 3;\n",
      "config/retry.json": '{"retryCount":5}\n',
    },
    "sandbox-review": {
      "src/queue.js":
        "const queue = [];\nexports.enqueue = item => queue.push(item);\nexports.drain = handler => {\n  while (queue.length) {\n    handler(queue[0]);\n  }\n};\n",
    },
    "sandbox-question": {
      "docs/glossary.md":
        "# Continuation terms\n自动接续: automatic continuation (`auto_continuation`).\n小脑接续: cerebellum continuation (`cerebellum_continuation`).\n",
    },
    "sandbox-small-edit": { "config/app.json": '{"timeout":3000}\n' },
    "sandbox-duplicate": {
      "docs/usage.md":
        "# Installation\n1. Install Node 22.\n2. Run npm install.\n3. Run npm test.\n",
      "package.json": '{"private":true,"scripts":{"test":"node --test"}}\n',
      "HISTORY.md":
        "A worker already updated docs/usage.md installation instructions to Node 22, npm install, npm test. Verify before making changes.\n",
    },
  };
  assert(fixtures[name], `unknown fixture ${name}`);
  for (const [file, content] of Object.entries(fixtures[name])) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return fixtures[name];
}
export function fixtureChanged(task, root, initial) {
  if (task.oracle === "no_delegation_but_work_done") {
    const file = join(root, "config/app.json");
    return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).timeout === 5000;
  }
  return Object.entries(initial).some(
    ([file, content]) =>
      !existsSync(join(root, file)) || readFileSync(join(root, file), "utf8") !== content,
  );
}
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const key of [`${row.arm} / ${row.task}`, `${row.arm} / ALL`]) {
      const g = groups.get(key) ?? {
        group: key,
        runs: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        timeout: 0,
      };
      g.runs++;
      if (row.status === "errored" || row.status === "timeout") g[row.status]++;
      else g[row.passed ? "passed" : "failed"]++;
      groups.set(key, g);
    }
  }
  const totals = [...groups.values()].filter((g) => g.group.endsWith("/ ALL"));
  const rates = totals.map((g) => g.passed / (g.passed + g.failed));
  const saturated =
    rates.length === 2 && (rates.every((r) => r === 0) || rates.every((r) => r === 1));
  console.log(
    `inconclusive — ${saturated ? "both arms saturated; " : ""}descriptive harness results; no calibrated noise floor or causal speed claim.`,
  );
  console.table(
    [...groups.values()].map((g) => ({
      ...g,
      successRate:
        g.passed + g.failed ? `${((100 * g.passed) / (g.passed + g.failed)).toFixed(1)}%` : "n/a",
    })),
  );
  console.log(
    "Limits: 3 repeats × 6 tasks = 18 observations/arm; standard error about ±11 percentage points. Differences below 20 points are unresolved. Errors and timeouts are excluded from success denominators. Both arms at 0% or 100% are saturated/inconclusive. Wall clocks are milliseconds; token records are measured provider usage, not estimates.",
  );
}
