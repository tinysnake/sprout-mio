import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collect,
  jobTiming,
  percentiles,
  readReports,
  seconds,
  timingReport,
} from "./timing-audit.mjs";

const stamp = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
function job(id = 1, attempt = 1) {
  return {
    id,
    name: "Linux / tooling",
    run_attempt: attempt,
    conclusion: "success",
    labels: ["ubuntu-24.04"],
    created_at: stamp(0),
    started_at: stamp(5),
    completed_at: stamp(45),
    steps: [
      {
        name: "Verify assigned gates",
        conclusion: "success",
        started_at: stamp(20),
        completed_at: stamp(40),
      },
    ],
  };
}
function run(id = 1, attempt = 1) {
  return {
    id,
    run_attempt: attempt,
    head_sha: "head",
    workflow_id: 1,
    event: "push",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    status: "completed",
    created_at: stamp(attempt === 1 ? 0 : -100),
    run_started_at: stamp(0),
  };
}
function sample(id, changes = {}) {
  return {
    workflow: { id: 1, path: ".github/workflows/ci.yml", fingerprint: "content-a" },
    runId: id,
    runAttempt: 1,
    event: "push",
    headSha: "head",
    conclusion: "success",
    createdAt: stamp(0),
    completedAt: stamp(id),
    jobs: [job()],
    ...changes,
  };
}
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), "ci-timing-audit-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

await test("timings separate queue, setup, Verify, and cleanup; incomplete or inverted timestamps remain null", () => {
  assert.deepEqual(jobTiming(job()), {
    queue: 5,
    setupBeforeVerify: 15,
    verifyRunning: 20,
    cleanup: 5,
    running: 40,
  });
  assert.equal(seconds(null, stamp(1)), null);
  assert.equal(seconds(stamp(1), stamp(0)), null);
  assert.equal(seconds(stamp(0), stamp(0)), 0);
  const incomplete = job();
  incomplete.steps[0].completed_at = null;
  assert.equal(jobTiming(incomplete).verifyRunning, null);
  assert.equal(jobTiming(incomplete).cleanup, null);
  incomplete.steps = [];
  assert.equal(jobTiming(incomplete).setupBeforeVerify, null);
});

await test("nearest-rank percentiles exclude missing measurements and separate version, event, attempt, and failures", () => {
  assert.deepEqual(percentiles([null, 0, 1, 2, 100]), { n: 4, p50: 1, p95: 100, max: 100 });
  assert.equal(percentiles([null]), null);
  const report = timingReport([
    ...Array.from({ length: 20 }, (_, index) => sample(index + 1)),
    sample(21, { completedAt: null }),
    sample(1, { runAttempt: 2, conclusion: "failure", completedAt: stamp(1000) }),
    sample(22, { workflow: { id: 1, path: ".github/workflows/ci.yml", fingerprint: "content-b" } }),
    sample(23, { event: "pull_request" }),
    sample(24, { conclusion: "cancelled" }),
    sample(25, { workflow: { id: 1, path: ".github/workflows/ci.yml", fingerprint: null } }),
  ]);
  assert.equal(report.cohorts.length, 5);
  assert.equal(report.unversionedAttempts, 1);
  assert.deepEqual(report.cohorts[0].feedbackSeconds, { n: 20, p50: 10, p95: 19, max: 20 });
  assert.equal(report.cohorts[1].feedbackSeconds, null);
  assert.equal(report.cohorts[1].jobs[0].seconds.verifyRunning, null);
  assert.equal(report.cohorts[4].feedbackSeconds, null);
  assert.throws(() => timingReport([sample(1), sample(1)]), /Duplicate run attempt/);
});

await test("collector paginates 150 runs and all jobs, preserves every attempt, and replays cached API data", (t) => {
  const directory = scratch(t);
  const calls = [];
  const fetch = (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes("/workflows/ci.yml/runs")) {
      const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
      return {
        workflow_runs: Array.from({ length: page === 1 ? 100 : 50 }, (_, index) =>
          run((page - 1) * 100 + index + 1, page === 1 && index === 0 ? 2 : 1),
        ),
      };
    }
    if (endpoint.includes("/contents/"))
      return { content: Buffer.from("workflow contents").toString("base64") };
    const match = /runs\/(\d+)\/attempts\/(\d+)/.exec(endpoint);
    assert(match, endpoint);
    const [, id, attempt] = match.map(Number);
    if (!endpoint.includes("/jobs?")) return run(id, attempt);
    const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
    return {
      jobs: Array.from({ length: id === 1 && attempt === 1 && page === 1 ? 100 : 1 }, (_, index) =>
        job((page - 1) * 100 + index, attempt),
      ),
    };
  };
  const samples = collect(directory, "owner/repo", 150, fetch);
  assert.equal(samples.length, 151);
  assert.equal(samples[0].jobs.length, 101);
  assert.equal(samples[1].runId, 1);
  assert.equal(samples[1].runAttempt, 2);
  assert.equal(samples[1].createdAt, stamp(-100));
  assert.equal(samples[1].feedbackStartedAt, stamp(0));
  assert.equal(timingReport([samples[1]]).samples[0].feedbackSeconds, 45);
  assert(samples[0].workflow.fingerprint);
  assert.equal(samples[0].completedAt, stamp(45));
  assert(calls.some((endpoint) => endpoint.includes("runs?per_page=100&page=2")));
  assert(calls.some((endpoint) => endpoint.includes("attempts/1/jobs?per_page=100&page=2")));
  assert.deepEqual(
    collect(directory, "owner/repo", 150, () => {
      throw new Error("must replay");
    }),
    samples,
  );
  assert.throws(() => collect(directory, "other/repo", 150, fetch), /another workflow/);
});

await test("gate and unit reports attach only to the matching attempt and omit raw diagnostic content", (t) => {
  const directory = scratch(t);
  const path = join(directory, "gate.json");
  writeFileSync(
    path,
    JSON.stringify({
      durationMs: 42,
      outcomes: [{ id: "b-tooling", status: "failed", durationMs: 40, log: "private-token" }],
      logs: "private-token",
    }),
  );
  const manifest = join(directory, "reports.json");
  writeFileSync(manifest, JSON.stringify([{ runId: 1, runAttempt: 2, kind: "gate", path }]));
  const report = timingReport([sample(1), sample(1, { runAttempt: 2 })], readReports(manifest));
  assert.equal(report.samples[0].reports.length, 0);
  assert.equal(report.samples[1].reports[0].gates[0].durationMs, 40);
  assert(!JSON.stringify(report).includes("private-token"));
});
