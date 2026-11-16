import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
export { seedFixture, fixtureDefinition } from "./fixtures.mjs";

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
  leadFinalReplyText: null,
  firstDelegationTerminalAtMs: null,
  artifactAssertions: null,
  workerRuns: null,
  runs: null,
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
export function evaluateOracle(name, f) {
  assert(oracleNames.includes(name), `unknown oracle ${name}`);
  const gates = {};
  const gate = (name, checks, actual) => {
    gates[name] = { passed: Object.values(checks).every(Boolean), checks, actual };
  };
  gate(
    "runs",
    {
      present: Array.isArray(f.runs) && f.runs.length > 0,
      allCompleted: f.runs?.every((r) => r.status === "completed") === true,
    },
    { runs: f.runs ?? null },
  );
  gate(
    "artifactsPass",
    {
      present: Array.isArray(f.artifactAssertions) && f.artifactAssertions.length > 0,
      allExitZero: f.artifactAssertions?.every((c) => c.exitCode === 0) === true,
    },
    { assertions: f.artifactAssertions ?? null },
  );
  const validFinal = () =>
    gate(
      "validFinal",
      {
        timestampPresent: f.leadFinalReplyAtMs != null,
        nonemptyText: Boolean(f.leadFinalReplyText?.trim()),
      },
      { atMs: f.leadFinalReplyAtMs ?? null, text: f.leadFinalReplyText ?? null },
    );
  if (["delegate_confirmed", "delegate_parallel", "worker_finishes"].includes(name)) {
    gate(
      "workersDone",
      {
        delegated: f.delegatedCount > 0,
        enoughRuns: Boolean(f.workerRunTerminalStatuses?.length >= f.delegatedCount),
        allCompleted: f.workerRunTerminalStatuses?.every((s) => s === "completed") === true,
        reportCountMatches: f.workerReportedComplete?.length === f.delegatedCount,
        reportedComplete: f.workerReportedComplete?.every(Boolean) === true,
      },
      {
        delegatedCount: f.delegatedCount ?? null,
        terminalStatuses: f.workerRunTerminalStatuses ?? null,
        reportedComplete: f.workerReportedComplete ?? null,
        workerRuns: f.workerRuns ?? null,
      },
    );
    const targets = f.requiredDelegationArtifacts ?? [];
    const evidence = f.delegationEvidence ?? [];
    const mapped = (d, file) =>
      d.requestArtifacts.includes(file) && d.workerArtifacts.includes(file);
    gate(
      "attribution",
      {
        targetsPresent: targets.length > 0,
        delegationCountMatches: f.delegationEvidence?.length === f.delegatedCount,
        everyDelegationMapped: evidence.every((d) =>
          d.requestArtifacts.some((file) => mapped(d, file)),
        ),
        allTargetsCovered: targets.every((file) => evidence.some((d) => mapped(d, file))),
      },
      {
        targets,
        delegatedCount: f.delegatedCount ?? null,
        delegations: evidence,
        unmappedDelegations: evidence.filter(
          (d) => !d.requestArtifacts.some((file) => mapped(d, file)),
        ),
        uncoveredTargets: targets.filter((file) => !evidence.some((d) => mapped(d, file))),
      },
    );
    if (name !== "worker_finishes") {
      validFinal();
      gate(
        "afterComplete",
        {
          validFinal: gates.validFinal.passed,
          eventCountMatches: f.completeEventTimes?.length === f.delegatedCount,
          strictlyAfter: f.completeEventTimes?.every((t) => f.leadFinalReplyAtMs > t) === true,
        },
        {
          completeEventTimes: f.completeEventTimes ?? null,
          leadFinalReplyAtMs: f.leadFinalReplyAtMs ?? null,
          delegatedCount: f.delegatedCount ?? null,
        },
      );
    }
    if (name === "delegate_parallel")
      gate(
        "parallel",
        {
          twoDelegations: f.delegatedCount === 2,
          twoProfiles: f.distinctWorkerProfiles?.length === 2,
        },
        {
          delegatedCount: f.delegatedCount ?? null,
          distinctWorkerProfiles: f.distinctWorkerProfiles ?? null,
        },
      );
  } else {
    validFinal();
    if (name === "no_duplicate")
      gate(
        "noDuplicate",
        {
          artifactActivity: f.artifactToolCalls?.includes("docs/usage.md") === true,
          countsPresent: f.delegationsPerArtifact != null,
          atMostOne:
            f.delegationsPerArtifact != null &&
            Object.values(f.delegationsPerArtifact).every((count) => count <= 1),
        },
        {
          artifactToolCalls: f.artifactToolCalls ?? null,
          delegationsPerArtifact: f.delegationsPerArtifact ?? null,
        },
      );
    else
      gate(
        "noDelegation",
        { zeroDelegations: f.delegatedCount === 0 },
        { delegatedCount: f.delegatedCount ?? null },
      );
  }
  const failedGates = Object.keys(gates).filter((name) => !gates[name].passed);
  return { oracle: name, passed: failedGates.length === 0, failedGates, gates };
}

export function judge(name, f) {
  return evaluateOracle(name, f).passed;
}

export function finalizeVerdict(row) {
  const evaluated = ["passed", "failed"].includes(row.status);
  row.verdict = {
    ...evaluateOracle(row.oracle, row),
    evaluated,
    outcome: row.status,
    execution: {
      reason: row.reason ?? row.violation ?? row.error?.message ?? null,
      error: row.error ?? null,
      evidenceError: row.evidenceError ?? null,
      evidenceProbe: row.evidenceProbe ?? null,
      cleanupError: row.cleanupError ?? null,
      runs: (row.runs ?? []).filter((run) => run.status !== "completed"),
    },
  };
  // Unobserved or interrupted execution cannot establish an oracle outcome.
  if (!evaluated) row.verdict.passed = null;
  return row.verdict;
}

export function forbiddenDelegation(oracle, delegatedCount) {
  return ["no_delegation", "no_delegation_but_work_done"].includes(oracle) && delegatedCount > 0;
}

export function preserveOutcome(row, oracle, delegatedCount, cleanupError) {
  if (forbiddenDelegation(oracle, delegatedCount)) {
    row.delegatedCount = delegatedCount;
    row.status = "failed";
    row.passed = false;
    row.violation = "delegation forbidden by task oracle";
  }
  if (cleanupError) row.cleanupError = cleanupError.message;
}

export function recordTaskError(row, error, interrupted = false) {
  const measured = ["passed", "failed"].includes(row.status) && typeof row.passed === "boolean";
  if (!measured) {
    row.status = errorStatus(error, interrupted);
    row.passed = null;
  }
  row.error = { message: error.message, stack: error.stack, code: error.code ?? null };
  if (error.code?.startsWith("AB_EVIDENCE_PROBE_")) {
    row.evidenceProbe = {
      status: error.code === "AB_EVIDENCE_PROBE_TIMEOUT" ? "timeout" : "error",
      reason: error.message,
    };
  }
}

export function errorStatus(error, interrupted = false) {
  return (
    error.runClassification ??
    (interrupted
      ? "interrupted"
      : ["AB_TIMEOUT", "AB_EVIDENCE_PROBE_TIMEOUT"].includes(error.code) ||
          error.name === "TimeoutError"
        ? "timeout"
        : "errored")
  );
}

export function preflightHashes(rows) {
  const hashes = rows.map((row) => [
    ...new Set(
      (row.runs ?? [])
        .filter((run) => run.role === "lead")
        .flatMap((run) => run.systemPromptHashes ?? []),
    ),
  ]);
  assert.equal(hashes.length, 2, "preflight requires two arms");
  assert(
    hashes.every((values) => values.length && values.every((h) => /^[a-f0-9]{64}$/.test(h))),
    "refuse to start live batch: missing observed preflight system prompt hash",
  );
  assert(
    !hashes[0].some((hash) => hashes[1].includes(hash)),
    "refuse to start live batch: preflight system prompt hashes match",
  );
  return hashes;
}

export function classifyRuns(runs) {
  if (runs.some((r) => r.status === "aborted")) return "aborted";
  if (runs.some((r) => ["interrupted", "canceled"].includes(r.status))) return "interrupted";
  if (runs.some((r) => ["timeout", "timed_out"].includes(r.status))) return "timeout";
  if (runs.some((r) => r.status === "failed")) return "errored";
  return null;
}

export function planBatch(arms, tasks, repeats) {
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const task of tasks)
      for (const arm of repeat % 2 ? arms : [...arms].reverse())
        plan.push({ arm: arm.arm, ref: arm.ref, task: task.id, repeat });
  return plan;
}

export function comparisonReasons(rows, { batch = true, dry = false } = {}) {
  if (!batch) return ["single arm; comparison requires two arms"];
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (rows.some((r) => !["passed", "failed"].includes(r.status)))
    add("incomplete batch: anomalous or not_run items");
  const arms = [...new Set(rows.map((r) => r.arm))];
  if (arms.length !== 2) add("comparison requires two arms");
  const heads = arms.map((arm) => new Set(rows.filter((r) => r.arm === arm).map((r) => r.head)));
  if (heads.some((set) => set.size !== 1 || !/^[a-f0-9]{40}$/.test([...set][0] ?? "")))
    add("missing or unstable resolved commit SHA");
  if (heads.length === 2 && [...heads[0]].some((sha) => heads[1].has(sha)))
    add("arms resolve to the same commit SHA");
  const groups = new Map();
  for (const row of rows) {
    if (["passed", "failed"].includes(row.status) && !row.runs?.length)
      add("completed item has no ready snapshots");
    for (const run of row.runs ?? []) {
      const key = `${row.task}/${run.role}`;
      const group = groups.get(key) ?? new Map();
      const list = group.get(row.arm) ?? [];
      list.push(run);
      group.set(row.arm, list);
      groups.set(key, group);
      if (run.status !== "completed") continue;
      if (
        !Number.isInteger(run.systemPromptChars) ||
        run.systemPromptChars <= 0 ||
        !Array.isArray(run.availableTools) ||
        !run.availableTools.length
      )
        add(`missing ready resources.systemPromptChars or tools for completed ${run.role} run`);
      if (run.inheritHostResources !== false) add("host resource inheritance was not disabled");
      if (
        dry &&
        (!run.systemPromptHashes?.length ||
          run.systemPromptHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)))
      )
        add(`missing observed system prompt hash for completed ${run.role} run`);
    }
  }
  for (const [key, group] of groups) {
    if (arms.length !== 2) continue;
    const [a, b] = arms.map((arm) => group.get(arm) ?? []);
    if (!a.length || !b.length) {
      add(`missing matching role ${key}`);
      continue;
    }
    const tools = (runs) =>
      [...new Set(runs.map((r) => JSON.stringify([...(r.availableTools ?? [])].sort())))].sort();
    if (JSON.stringify(tools(a)) !== JSON.stringify(tools(b)))
      add(`tool name sets differ for ${key}`);
    if (a.some((x) => b.some((y) => x.systemPromptChars === y.systemPromptChars)))
      add(`system prompt character counts overlap for ${key}`);
    if (
      dry &&
      a.some((x) =>
        b.some((y) => x.systemPromptHashes?.some((h) => y.systemPromptHashes?.includes(h))),
      )
    )
      add(`observed system prompt hashes match for ${key}`);
  }
  return reasons;
}

export function summarize(rows, options = {}) {
  const reasons = comparisonReasons(rows, options);
  console.log(
    reasons.length
      ? `Comparison refused: ${reasons.join("; ")}`
      : "Comparison eligible; descriptive results only.",
  );
  const groups = new Map();
  for (const row of rows) {
    for (const key of [`${row.arm} / ${row.task}`, `${row.arm} / ALL`]) {
      const g = groups.get(key) ?? {
        group: key,
        planned: 0,
        attempted: 0,
        completed: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        timeout: 0,
        aborted: 0,
        interrupted: 0,
        not_run: 0,
      };
      g.planned++;
      if (row.status !== "not_run") g.attempted++;
      if (["passed", "failed"].includes(row.status)) {
        g.completed++;
        g[row.status]++;
      } else if (Object.hasOwn(g, row.status)) g[row.status]++;
      else throw new Error(`unknown ledger status ${row.status}`);
      groups.set(key, g);
    }
  }
  const totals = [...groups.values()].filter((g) => g.group.endsWith("/ ALL"));
  const rates = totals.map((g) => g.passed / g.completed);
  const saturated =
    rates.length === 2 && (rates.every((r) => r === 0) || rates.every((r) => r === 1));
  console.table(
    [...groups.values()].map((g) => ({
      ...g,
      successRate:
        reasons.length || !g.completed ? "n/a" : `${((100 * g.passed) / g.completed).toFixed(1)}%`,
    })),
  );
  console.log(
    `inconclusive — ${saturated ? "both arms saturated; " : ""}no calibrated noise floor or causal speed claim.`,
  );
  console.log(
    "Only passed/failed completed items enter the success denominator. Aborted, interrupted, timeout, errored and not_run are excluded. Rates are suppressed when comparison is refused. Tokens are measured provider usage; clocks are milliseconds.",
  );
  return { reasons, groups: [...groups.values()] };
}
