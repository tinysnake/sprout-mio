import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { comparisonReasons, summarize } from "./core.mjs";
import { summarizeRejudged } from "./rejudge.mjs";

function ledger() {
  return ["A", "B"].map((arm, i) => ({
    arm,
    task: "trim",
    repeat: 1,
    status: "passed",
    head: String(i + 1).repeat(40),
    verdict: { passed: true },
    verdictCorrected: { passed: true },
    probeDelegationEvidence: [],
    runs: ["lead", "worker"].map((role) => ({
      role,
      status: "completed",
      thinkingEffective: "low",
      inheritHostResources: false,
      systemPromptChars: 200 - i * 100,
      systemPromptHashes: [String(i + 1).repeat(64)],
      availableTools: i
        ? ["shared", "z_new", "a_new"]
        : ["sprout_lease_wait", "shared", "sprout_lease_acquire"],
    })),
  }));
}

function capture(rows, options) {
  const lines = [];
  const log = console.log,
    table = console.table;
  try {
    console.log = (...args) => lines.push(args.join(" "));
    console.table = () => {};
    return { summary: summarize(rows, options), report: lines.join("\n") };
  } finally {
    console.log = log;
    console.table = table;
  }
}

test("tool delta is opt-in and reports sorted differences for every task/role", () => {
  const rows = ledger();
  const refused = ["tool name sets differ for trim/lead", "tool name sets differ for trim/worker"];
  assert.deepEqual(comparisonReasons(rows, { allowToolDelta: false }), refused);
  assert.deepEqual(comparisonReasons(rows, { allowToolDelta: true }), []);
  const { summary, report } = capture(rows, { allowToolDelta: true });
  assert.deepEqual(summary.reasons, []);
  assert.match(report, /工具面差异/);
  for (const role of ["lead", "worker"]) {
    assert.ok(report.includes(`trim/${role}: 基线臂 A=3; 精简臂 B=3`));
  }
  assert.match(report, /只在基线臂: sprout_lease_acquire, sprout_lease_wait/);
  assert.match(report, /只在精简臂: a_new, z_new/);
  assert.equal(summary.toolDeltaReport, summarizeRejudged(rows).toolDeltaReport);
});

test("only the literal environment value 1 opts into tool delta", () => {
  for (const value of [undefined, "0", "true", "1"]) {
    const env = { ...process.env };
    delete env.AB_ALLOW_TOOL_DELTA;
    if (value !== undefined) env.AB_ALLOW_TOOL_DELTA = value;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { comparisonReasons } from ${JSON.stringify(new URL("./core.mjs", import.meta.url).href)};
       console.log(JSON.stringify(comparisonReasons(${JSON.stringify(ledger())})));`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).length, value === "1" ? 0 : 2, String(value));
  }
});

test("allowing tool delta preserves every other comparison gate", () => {
  const rows = ledger();
  rows[1].runs[0].systemPromptChars = rows[0].runs[0].systemPromptChars;
  rows[1].runs[0].thinkingEffective = "high";
  rows[1].runs[0].inheritHostResources = true;
  rows[1].runs[0].systemPromptHashes = rows[0].runs[0].systemPromptHashes;
  rows.push({ ...structuredClone(rows[0]), head: "3".repeat(40), repeat: 2 });
  const strict = comparisonReasons(rows, { dry: true, allowToolDelta: false });
  for (const reason of [
    "system prompt character counts overlap for trim/lead",
    "effective thinking levels differ for trim/lead",
    "host resource inheritance was not disabled",
    "missing or unstable resolved commit SHA",
    "observed system prompt hashes match for trim/lead",
  ])
    assert.ok(strict.includes(reason), reason);
  assert.deepEqual(
    comparisonReasons(rows, { dry: true, allowToolDelta: true }),
    strict.filter((reason) => !reason.startsWith("tool name sets differ for ")),
  );
});

test("identical tools keep the verdict and report no differences with either setting", () => {
  const rows = ledger();
  rows[1].runs.forEach((run, i) => {
    run.availableTools = [...rows[0].runs[i].availableTools].reverse();
  });
  for (const allowToolDelta of [false, true]) {
    const { summary, report } = capture(rows, { allowToolDelta });
    assert.deepEqual(summary.reasons, []);
    assert.match(report, /工具面差异/);
    assert.match(report, /无差异/);
    assert.match(report, /trim\/worker: 基线臂 A=3; 精简臂 B=3/);
  }
});
