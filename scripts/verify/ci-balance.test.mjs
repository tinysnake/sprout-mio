import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gateDurations,
  gateSamples,
  largestProcessingTime,
  loadMs,
  preparationModel,
  rebalance,
  validateCoverage,
} from "./lib/ci-balance.mjs";

const report = (id, outcomes, preparation = [{ kind: "install", durationMs: 2000 }]) => ({
  runId: id,
  outcomes: outcomes.map(([gate, durationMs]) => ({ id: gate, status: "passed", durationMs })),
  preparation: preparation.map((entry) => ({ status: "passed", ...entry })),
});

test("samples average repeated reports and keep the slowest observation", () => {
  const samples = gateSamples([
    report("run-1", [
      ["a", 100],
      ["b", 40],
    ]),
    report("run-2", [
      ["a", 200],
      ["b", 40],
    ]),
  ]);
  const durations = gateDurations(samples);
  assert.deepEqual(durations.get("a"), { ms: 150, maxMs: 200, samples: 2 });
  assert.deepEqual(durations.get("b"), { ms: 40, maxMs: 40, samples: 2 });
  assert.throws(
    () =>
      gateSamples([
        report("run-1", [
          ["a", 100],
          ["a", 200],
        ]),
      ]),
    /Duplicate gate in one report: a/,
  );
});

test("invalid or unsuccessful timings cannot influence a proposed plan", () => {
  for (const durationMs of [undefined, null, NaN, Infinity, -1]) {
    assert.throws(() => gateSamples([report("bad", [["a", durationMs]])]), /Invalid successful/);
    assert.throws(
      () => preparationModel([report("bad", [], [{ kind: "install", durationMs }])]),
      /Invalid successful/,
    );
  }
  const failed = report("failed", [["a", 0]]);
  failed.outcomes[0].status = "failed";
  assert.throws(() => gateSamples([failed]), /Invalid successful/);
  assert.throws(
    () =>
      preparationModel([
        report("failed", [], [{ kind: "install", status: "failed", durationMs: 0 }]),
      ]),
    /Invalid successful/,
  );
});

test("coverage rejects reports that miss or add gates", () => {
  const groups = { one: ["a"], two: ["b"] };
  assert.throws(
    () => validateCoverage(gateSamples([report("run-1", [["a", 1]])]), groups),
    /do not cover assigned gates: b/,
  );
  assert.throws(
    () =>
      validateCoverage(
        gateSamples([
          report("run-1", [
            ["a", 1],
            ["b", 1],
            ["c", 1],
          ]),
        ]),
        groups,
      ),
    /unassigned gates: c/,
  );
  assert.doesNotThrow(() =>
    validateCoverage(
      gateSamples([
        report("run-1", [
          ["a", 1],
          ["b", 1],
        ]),
      ]),
      groups,
    ),
  );
});

test("preparation averages the observed install and server runs", () => {
  const model = preparationModel([
    report(
      "run-1",
      [],
      [
        { kind: "install", durationMs: 2000 },
        { kind: "server", durationMs: 8000 },
      ],
    ),
    report(
      "run-2",
      [],
      [
        { kind: "install", durationMs: 3000 },
        { kind: "server", durationMs: 10000 },
      ],
    ),
  ]);
  assert.deepEqual(model, { installMs: 2500, serverMs: 9000 });
  assert.throws(() => preparationModel([{ outcomes: [], preparation: [] }]), /install preparation/);
});

test("a group pays the shared server build once no matter how many gates need it", () => {
  const durations = gateDurations(gateSamples([report("run-1", [["p7-client-pwa", 1000]])]));
  const preparation = { installMs: 200, serverMs: 900 };
  assert.equal(loadMs([], durations, preparation), 200);
  assert.equal(loadMs(["p7-client-pwa"], durations, preparation), 2100);
});

test("largest processing time fills the least loaded group", () => {
  const durations = new Map(
    [10, 9, 8, 7, 6, 5].map((seconds, index) => [
      `gate-${index}`,
      { ms: seconds * 1000, maxMs: seconds * 1000, samples: 1 },
    ]),
  );
  const { loadsMs } = largestProcessingTime({
    names: ["one", "two"],
    durations,
    preparation: { installMs: 0, serverMs: 0 },
  });
  assert.deepEqual(
    Object.values(loadsMs).sort((left, right) => left - right),
    [22000, 23000],
  );
});

test("rebalance keeps a balanced plan and only moves gates that lower the peak", () => {
  const durations = new Map(
    [10, 9, 8, 7, 6, 5].map((seconds, index) => [
      `gate-${index}`,
      { ms: seconds * 1000, maxMs: seconds * 1000, samples: 1 },
    ]),
  );
  const preparation = { installMs: 0, serverMs: 0 };
  const settled = rebalance({
    groups: { one: ["gate-0", "gate-3", "gate-5"], two: ["gate-1", "gate-2", "gate-4"] },
    durations,
    preparation,
  });
  assert.deepEqual(settled.moved, []);
  assert.deepEqual(settled.loadsMs, { one: 22000, two: 23000 });

  const imbalanced = rebalance({
    groups: { one: ["gate-0", "gate-1"], two: ["gate-2"] },
    durations,
    preparation,
  });
  assert.ok(Math.max(...Object.values(imbalanced.loadsMs)) < 19000);
  assert.equal(imbalanced.moved.length, 1);
  assert.deepEqual(imbalanced.moved, [{ id: "gate-1", from: "one", to: "two" }]);
});
