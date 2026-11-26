import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function seconds(start, end) {
  const from = typeof start === "string" ? Date.parse(start) : NaN;
  const to = typeof end === "string" ? Date.parse(end) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? (to - from) / 1000 : null;
}

export function percentiles(values) {
  const sorted = values
    .filter((value) => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  return sorted.length
    ? {
        n: sorted.length,
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        max: sorted.at(-1),
      }
    : null;
}

export function jobTiming(job) {
  const verify = job.steps?.find(
    (step) =>
      step.conclusion !== "skipped" &&
      /^Verify (assigned gates|portable unit shard)$/.test(step.name),
  );
  return {
    queue: seconds(job.created_at, job.started_at),
    setupBeforeVerify: seconds(job.started_at, verify?.started_at),
    verifyRunning: seconds(verify?.started_at, verify?.completed_at),
    cleanup: seconds(verify?.completed_at, job.completed_at),
    running: seconds(job.started_at, job.completed_at),
  };
}

export function timingReport(samples, reports = []) {
  const identities = new Set();
  const cohorts = new Map();
  const normalized = samples.map((sample) => {
    const identity = `${sample.runId}/${sample.runAttempt}`;
    if (identities.has(identity)) throw new Error(`Duplicate run attempt: ${identity}`);
    identities.add(identity);
    const jobs = sample.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      labels: job.labels,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      steps: job.steps?.map(({ name, conclusion, started_at, completed_at }) => ({
        name,
        conclusion,
        started_at,
        completed_at,
      })),
      seconds: jobTiming(job),
    }));
    const attached = reports.filter(
      (report) => report.runId === sample.runId && report.runAttempt === sample.runAttempt,
    );
    const result = { ...sample, jobs, reports: attached };
    const origin = Object.hasOwn(sample, "feedbackStartedAt")
      ? sample.feedbackStartedAt
      : sample.createdAt;
    return {
      ...result,
      feedbackSeconds:
        sample.collection?.jobsComplete === false ? null : seconds(origin, sample.completedAt),
    };
  });
  for (const sample of normalized) {
    if (!sample.workflow.fingerprint) continue;
    const key = JSON.stringify([
      sample.workflow,
      sample.event,
      sample.runAttempt,
      sample.conclusion,
    ]);
    const cohort = cohorts.get(key) ?? {
      workflow: sample.workflow,
      event: sample.event,
      runAttempt: sample.runAttempt,
      conclusion: sample.conclusion,
      runs: [],
    };
    cohort.runs.push(sample);
    cohorts.set(key, cohort);
  }
  return {
    schemaVersion: 1,
    percentileMethod:
      "nearest-rank; successful workflow attempts only; missing timestamps excluded",
    unversionedAttempts: normalized.filter((sample) => !sample.workflow.fingerprint).length,
    cohorts: [...cohorts.values()].map(({ runs, ...cohort }) => {
      const success = cohort.conclusion === "success";
      const jobs = new Map();
      for (const run of runs)
        for (const job of run.jobs) {
          const key = JSON.stringify([job.name, job.labels]);
          const group = jobs.get(key) ?? { name: job.name, labels: job.labels, samples: [] };
          group.samples.push({ ...job, complete: run.collection?.jobsComplete !== false });
          jobs.set(key, group);
        }
      return {
        ...cohort,
        attempts: runs.length,
        incompleteAttempts: runs.filter((run) => run.collection?.jobsComplete === false).length,
        feedbackSeconds: success ? percentiles(runs.map((run) => run.feedbackSeconds)) : null,
        jobs: [...jobs.values()].map(({ samples: rows, ...job }) => ({
          ...job,
          count: rows.length,
          seconds: Object.fromEntries(
            ["queue", "setupBeforeVerify", "verifyRunning", "cleanup", "running"].map((metric) => [
              metric,
              success
                ? percentiles(
                    rows
                      .filter((row) => row.conclusion === "success" && row.complete)
                      .map((row) => row.seconds[metric]),
                  )
                : null,
            ]),
          ),
        })),
      };
    }),
    samples: normalized,
  };
}

function gh(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`gh API failed (${result.status}): ${endpoint}`);
  return JSON.parse(result.stdout);
}

function cached(cache, name, fetch) {
  const path = join(cache, name);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(fetch(), null, 2) + "\n");
  return JSON.parse(readFileSync(path, "utf8"));
}

function pages(endpoint, field, fetch = gh) {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = fetch(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    rows.push(...result[field]);
    if (result[field].length < 100) return rows;
  }
}

export function collect(cache, repo, limit = 150, fetch = gh) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(limit) || limit < 150)
    throw new Error("collect requires --repo owner/repo and --limit >= 150");
  mkdirSync(cache, { recursive: true });
  const source = cached(cache, "source.json", () => ({ repo, workflow: "ci.yml" }));
  if (source.repo !== repo || source.workflow !== "ci.yml")
    throw new Error("Audit cache belongs to another workflow/repository");
  const runs = [];
  for (let page = 1; runs.length < limit; page++) {
    const result = cached(cache, `runs-page-${page}.json`, () =>
      fetch(`repos/${repo}/actions/workflows/ci.yml/runs?per_page=100&page=${page}`),
    );
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) break;
  }
  const samples = [];
  for (const run of runs.slice(0, limit)) {
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const detail = cached(cache, `run-${run.id}-attempt-${attempt}.json`, () =>
        fetch(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`),
      );
      const jobs = cached(cache, `jobs-${run.id}-attempt-${attempt}.json`, () =>
        pages(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs", fetch),
      );
      if (
        detail.id !== run.id ||
        detail.run_attempt !== attempt ||
        jobs.some((job) => job.run_attempt !== attempt)
      )
        throw new Error(`Mismatched attempt data: ${run.id}/${attempt}`);
      const path = detail.path.split("@")[0];
      const workflow = cached(cache, `workflow-${detail.workflow_id}-${detail.head_sha}.json`, () =>
        fetch(`repos/${repo}/contents/${path}?ref=${detail.head_sha}`),
      );
      samples.push(
        sampleRun(
          detail,
          jobs,
          createHash("sha256").update(Buffer.from(workflow.content, "base64")).digest("hex"),
        ),
      );
    }
  }
  writeFileSync(join(cache, "samples.json"), JSON.stringify(samples, null, 2) + "\n");
  return samples;
}

function sampleRun(run, jobs, fingerprint) {
  const ends = jobs.map((job) => job.completed_at);
  const completedAt =
    run.status === "completed" &&
    ends.length &&
    ends.every((end) => typeof end === "string" && Number.isFinite(Date.parse(end)))
      ? ends.sort().at(-1)
      : null;
  const starts = jobs.map((job) => job.created_at);
  const feedbackStartedAt =
    run.run_attempt === 1
      ? run.created_at
      : starts.length &&
          starts.every((start) => typeof start === "string" && Number.isFinite(Date.parse(start)))
        ? starts.sort()[0]
        : null;
  return {
    workflow: {
      id: run.workflow_id,
      path: run.path?.split("@")[0] ?? ".github/workflows/ci.yml",
      fingerprint,
    },
    runId: run.id,
    runAttempt: run.run_attempt,
    event: run.event,
    headSha: run.head_sha,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    startedAt: run.run_started_at,
    completedAt,
    feedbackStartedAt,
    feedbackStartedAtSource:
      run.run_attempt === 1 ? "run-created-at" : "earliest-job-created-at-proxy",
    jobs,
  };
}

export function replay(cache) {
  if (existsSync(join(cache, "samples.json"))) {
    const source = JSON.parse(readFileSync(join(cache, "source.json"), "utf8"));
    const samples = JSON.parse(readFileSync(join(cache, "samples.json"), "utf8"));
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(source.repo) ||
      source.workflow !== "ci.yml" ||
      !Array.isArray(samples) ||
      samples.some(
        (sample) =>
          !Number.isInteger(sample.runId) ||
          !Number.isInteger(sample.runAttempt) ||
          sample.runAttempt < 1 ||
          !sample.workflow ||
          sample.workflow.path !== ".github/workflows/ci.yml" ||
          !Array.isArray(sample.jobs) ||
          sample.jobs.some((job) => job.run_attempt !== sample.runAttempt),
      )
    )
      throw new Error("Invalid audit cache source or attempt data");
    return samples;
  }
  const raw = JSON.parse(readFileSync(join(cache, "runs.json"), "utf8"));
  const runs = Array.isArray(raw) ? raw : raw.workflow_runs;
  return runs.map((run) => {
    const rawJobs = JSON.parse(readFileSync(join(cache, `jobs-${run.id}.json`), "utf8"));
    const jobs = rawJobs.jobs.filter((job) => job.run_attempt === run.run_attempt);
    const path = run.path?.split("@")[0] ?? ".github/workflows/ci.yml";
    const source = spawnSync("git", ["show", `${run.head_sha}:${path}`], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const fingerprint =
      source.status === 0 ? createHash("sha256").update(source.stdout).digest("hex") : null;
    const sample = sampleRun(run, jobs, fingerprint);
    sample.collection = {
      source: "legacy-latest-attempt-only",
      earlierAttemptsMissing: run.run_attempt - 1,
      jobsComplete: rawJobs.total_count === rawJobs.jobs.length,
    };
    if (!sample.collection.jobsComplete) sample.completedAt = null;
    return sample;
  });
}

export function readReports(manifest) {
  return JSON.parse(readFileSync(manifest, "utf8")).map(({ runId, runAttempt, kind, path }) => {
    if (!["gate", "unit"].includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
    const report = JSON.parse(readFileSync(path, "utf8"));
    return {
      runId,
      runAttempt,
      kind,
      target: report.target,
      shard: report.shard,
      files: report.files,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      code: report.code,
      signal: report.signal,
      durationMs: report.durationMs,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      execution: report.execution && {
        executedFiles: report.execution.executedFiles,
        missingFiles: report.execution.missingFiles,
        unexpectedFiles: report.execution.unexpectedFiles,
        complete: report.execution.complete,
        success: report.execution.success,
        tests: report.execution.tests,
        failed: report.execution.failed,
        skipped: report.execution.skipped,
      },
      gates: report.outcomes?.map(({ id, status, durationMs, startedAt, finishedAt }) => ({
        id,
        status,
        durationMs,
        startedAt,
        finishedAt,
      })),
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--cache", "--repo", "--limit", "--out", "--reports"].includes(args[i]) || !args[i + 1])
      throw new Error(`Unknown option: ${args[i]}`);
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.cache || !["collect", "report"].includes(command))
    throw new Error(
      "Usage: timing-audit.mjs collect|report --cache <external directory> [--repo owner/repo] [--limit 150] [--out report.json] [--reports manifest.json]",
    );
  if (command === "collect") collect(options.cache, options.repo, Number(options.limit ?? 150));
  else {
    const report = timingReport(
      replay(options.cache),
      options.reports ? readReports(options.reports) : [],
    );
    if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n");
    else console.log(JSON.stringify(report, null, 2));
  }
}
