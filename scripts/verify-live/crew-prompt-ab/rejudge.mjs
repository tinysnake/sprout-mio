import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comparisonReasons, finalizeVerdict, toolDeltaReport } from "./core.mjs";
import { retryCountReported } from "./artifacts.mjs";
import { fixtureDefinition } from "./fixtures.mjs";
import { costMetricsFrom } from "./cost-metrics.mjs";
import { factsFrom } from "./evidence.mjs";
import { successCohort, successPopulation } from "./taskset2.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uniform = (values) =>
  values.length && values.every((v) => v != null && v === values[0]) ? values[0] : null;

export function rejudgeRow(input) {
  const row = structuredClone(input);
  const audit = { version: 1, evidence: [], warnings: [] };
  let evidence;
  if (row.evidenceDirectory) {
    const path = join(row.evidenceDirectory, "domain-evidence.json");
    try {
      const bytes = readFileSync(path);
      evidence = JSON.parse(bytes);
      audit.evidence.push({ path, sha256: hash(bytes) });
    } catch (error) {
      audit.warnings.push(`thinking evidence unavailable: ${error.message}`);
    }
  }
  const leadChatId = row.runs?.find((run) => run.role === "lead")?.chatId;
  if (
    leadChatId &&
    [evidence?.runs, evidence?.events, evidence?.delegations].every(Array.isArray)
  ) {
    try {
      for (const path of new Set(
        evidence.runs.map((run) => run.configSnapshot?.sessionFile).filter(Boolean),
      )) {
        audit.evidence.push({ path, sha256: hash(readFileSync(path)) });
      }
      const extracted = factsFrom(evidence, leadChatId);
      for (const key of Object.keys(costMetricsFrom())) row[key] = extracted[key];
      row.runs = extracted.runs.map((run) => ({
        ...row.runs?.find((old) => old.runId === run.runId),
        ...run,
      }));
      row.workerRuns = row.runs.filter((run) => run.role === "worker");
    } catch (error) {
      Object.assign(row, costMetricsFrom());
      row.runs = (row.runs ?? []).map((run) => ({ ...run, transcriptObserved: false }));
      audit.warnings.push(`metrics evidence unavailable: ${error.message}`);
    }
  }
  row.runs = (row.runs ?? []).map((run) => {
    const config = evidence?.runs?.find((r) => r.id === run.runId)?.configSnapshot;
    return {
      ...run,
      thinkingRequested: run.thinkingRequested ?? config?.profile?.effort ?? null,
      thinkingEffective: run.thinkingEffective ?? config?.thinking ?? null,
    };
  });
  row.thinkingRequested = uniform(row.runs.map((r) => r.thinkingRequested));
  row.thinkingEffective = uniform(row.runs.map((r) => r.thinkingEffective));
  row.machineScopes ??= row.machineScope ? [row.machineScope] : [];
  row.artifactAssertionsCorrected ??= (row.artifactAssertions ?? []).map((entry) => {
    if (row.oracle !== "delegate_parallel" || entry.name !== "parallel" || entry.exitCode === 0)
      return entry;
    // Recheck only our known retry assertion failure. Never execute a recorded command.
    if (
      entry.exitCode !== 1 ||
      !/AssertionError \[ERR_ASSERTION\]: lead names retry count /.test(entry.stderr ?? "")
    )
      return entry;
    const expected = fixtureDefinition("sandbox-parallel").expected;
    try {
      const files = ["README.md", ...expected.retryFiles].map((file) => {
        const path = join(entry.cwd, file);
        const bytes = readFileSync(path);
        audit.evidence.push({ path, sha256: hash(bytes) });
        return [file, bytes.toString("utf8")];
      });
      const contents = Object.fromEntries(files);
      const lines = contents["README.md"].split(/\r?\n/);
      const passed =
        lines.includes(expected.nodeLine) &&
        !lines.includes(expected.oldNodeLine) &&
        expected.retryFiles.every((file) =>
          retryCountReported(row.leadFinalReplyText ?? "", file, expected.retryCounts[file], true),
        );
      return {
        ...entry,
        exitCode: passed ? 0 : entry.exitCode,
        rejudged: {
          originalExitCode: entry.exitCode,
          passed,
          source: "read-only fixture files and ledger final reply; no command executed",
        },
      };
    } catch (error) {
      audit.warnings.push(`artifact recheck unavailable: ${error.message}`);
      return entry;
    }
  });
  if (["passed", "failed"].includes(row.status))
    audit.originalOutcome = { status: row.status, passed: row.passed ?? null };
  finalizeVerdict(row);
  if (audit.originalOutcome) {
    row.status = row.verdict.outcome;
    row.passed = row.verdict.passed;
  }
  row.rejudge = audit;
  return row;
}

export function summarizeRejudged(rows) {
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const summarize = (items, field) => ({
    passed: items.filter((r) => r[field].passed === true).length,
    failed: items.filter((r) => r[field].passed === false).length,
    excluded: items.filter((r) => r[field].passed === null).length,
    total: items.length,
  });
  const readings = Object.fromEntries(
    ["verdict", "verdictCorrected"].map((field) => [
      field,
      Object.fromEntries(
        arms.map((arm) => [
          arm,
          summarize(
            rows.filter((r) => r.arm === arm && successCohort(r) === "ALL"),
            field,
          ),
        ]),
      ),
    ]),
  );
  const sanityReadings = Object.fromEntries(
    ["verdict", "verdictCorrected"].map((field) => [
      field,
      Object.fromEntries(
        arms.map((arm) => [
          arm,
          summarize(
            rows.filter((row) => row.arm === arm && successCohort(row) === "SANITY"),
            field,
          ),
        ]),
      ),
    ]),
  );
  const tasks = [...new Set(rows.map((r) => r.task))].map((task) => {
    const items = rows.filter((r) => r.task === task);
    const paired = {};
    for (const field of ["verdict", "verdictCorrected"]) {
      const pairs = [...new Set(items.map((r) => r.repeat))].map((repeat) => {
        const a = items.find((r) => r.repeat === repeat && r.arm === "A");
        const b = items.find((r) => r.repeat === repeat && r.arm === "B");
        const eligible = a?.[field].passed != null && b?.[field].passed != null;
        return {
          repeat,
          eligible,
          A: a?.[field].passed ?? null,
          B: b?.[field].passed ?? null,
          deltaBMinusA: eligible ? Number(b[field].passed) - Number(a[field].passed) : null,
        };
      });
      paired[field] = {
        arms: Object.fromEntries(
          arms.map((arm) => [
            arm,
            summarize(
              items.filter((r) => r.arm === arm),
              field,
            ),
          ]),
        ),
        pairs,
        pairedDeltaBMinusA: pairs.reduce((sum, pair) => sum + (pair.deltaBMinusA ?? 0), 0),
        eligiblePairs: pairs.filter((p) => p.eligible).length,
      };
    }
    return { task, category: items[0].category ?? "primary", ...paired };
  });
  const thinking = {};
  for (const row of rows)
    for (const run of row.runs ?? []) {
      const key = `${row.arm}: ${run.thinkingRequested ?? "unknown"} -> ${run.thinkingEffective ?? "unknown"}`;
      thinking[key] = (thinking[key] ?? 0) + 1;
    }
  return {
    rows: rows.length,
    readings,
    sanityReadings,
    successPopulation,
    tasks,
    probeDelegations: rows.flatMap((r) =>
      r.probeDelegationEvidence.map((d) => ({ arm: r.arm, task: r.task, repeat: r.repeat, ...d })),
    ),
    thinking,
    comparisonReasons: comparisonReasons(rows),
    toolDeltaReport: toolDeltaReport(rows),
    changed: rows
      .filter((r) => r.verdict.passed !== r.verdictCorrected.passed)
      .map((r) => ({
        arm: r.arm,
        task: r.task,
        repeat: r.repeat,
        preregistered: r.verdict.passed,
        corrected: r.verdictCorrected.passed,
        failedGates: r.verdict.failedGates,
        failedGatesCorrected: r.verdictCorrected.failedGates,
      })),
  };
}

export function rejudgeLedger(inputPath, outputPath) {
  const input = realpathSync(inputPath);
  const output = resolve(realpathSync(dirname(outputPath)), outputPath.split(/[\\/]/).at(-1));
  assert(input !== output, "output must differ from input ledger");
  if (existsSync(output)) {
    const a = statSync(input),
      b = statSync(output);
    assert(a.dev !== b.dev || a.ino !== b.ino, "output must not alias input ledger");
  }
  // One read defines the snapshot, even while the source batch continues appending.
  const bytes = readFileSync(input);
  const lastNewline = bytes.lastIndexOf(10);
  let complete = bytes;
  let ignoredTrailingBytes = 0;
  if (bytes.length && bytes.at(-1) !== 10) {
    try {
      JSON.parse(bytes.subarray(lastNewline + 1).toString("utf8"));
    } catch {
      complete = bytes.subarray(0, lastNewline + 1);
      ignoredTrailingBytes = bytes.length - complete.length;
    }
  }
  const inputs = complete
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map(JSON.parse);
  const rows = inputs.map(rejudgeRow);
  const source = {
    path: input,
    sha256: hash(complete),
    bytes: complete.length,
    rows: rows.length,
    ignoredTrailingBytes,
  };
  for (const row of rows) row.rejudge.ledger = source;
  writeFileSync(
    output,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
    { flag: "wx", mode: 0o600 },
  );
  return { source, ...summarizeRejudged(rows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, "usage: node rejudge.mjs <ledger.jsonl> <out.jsonl>");
    console.log(JSON.stringify(rejudgeLedger(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
