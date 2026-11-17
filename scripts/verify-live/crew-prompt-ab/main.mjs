import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  taskSet,
  summarize,
  unknownEvidence,
  planBatch,
  preflightHashes,
  finalizeVerdict,
  retryTransient,
} from "./core.mjs";
import { runTask } from "./run-task.mjs";
import { runTaskWithLockRetry } from "./lock-retry.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const model = process.env.AB_MODEL || process.env.SPROUT_VERIFY_PI_MODEL;
assert(model, "AB_MODEL or SPROUT_VERIFY_PI_MODEL must explicitly name a model");
const dry = process.env.AB_DRY === "1";
const batch = process.argv.includes("--batch");
const repeats = Number(process.env.AB_REPEAT ?? 1);
const timeoutMs = Number(process.env.AB_TASK_TIMEOUT_MS ?? 600000);
assert(Number.isInteger(repeats) && repeats > 0, "AB_REPEAT must be a positive integer");
assert(
  Number.isInteger(timeoutMs) && timeoutMs > 0,
  "AB_TASK_TIMEOUT_MS must be a positive integer",
);
const tasks = taskSet(
  resolve(process.env.AB_TASK_SOURCE ?? join(root, "docs/plans/crew-prompt-ab.md")),
);
const requested = process.env.AB_TASKS?.split(/[\s,]+/).filter(Boolean);
if (requested)
  for (const id of requested)
    assert(
      tasks.some((t) => t.id === id),
      `unknown task ${id}`,
    );
const selected = tasks.filter((t) => !requested || requested.includes(t.id));
const arms = batch
  ? [
      { arm: "A", ref: process.env.AB_REF_A },
      { arm: "B", ref: process.env.AB_REF_B },
    ]
  : [{ arm: process.env.AB_ARM ?? "A", ref: process.env.AB_REF }];
for (const arm of arms)
  assert(arm.ref, batch ? "AB_REF_A and AB_REF_B are required" : "AB_REF is required");
const out = resolve(process.env.AB_OUT ?? join(root, ".verify/crew-prompt-ab.jsonl"));
const evidence = join(dirname(out), `crew-prompt-ab-${Date.now()}-${process.pid}`);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const rows = [],
  worktrees = [];
const plan = planBatch(arms, selected, repeats);
writeFileSync(join(evidence, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
const key = (item) => `${item.arm}/${item.task}/${item.repeat}`;
const recorded = new Set();
function record(row) {
  finalizeVerdict(row);
  assert(!recorded.has(key(row)), "one ledger row per planned item");
  appendFileSync(out, JSON.stringify(row) + "\n", { mode: 0o600 });
  recorded.add(key(row));
  rows.push(row);
  console.log(`${row.status.toUpperCase()} ${row.arm} ${row.task} repeat=${row.repeat} out=${out}`);
}
let fatal;
let sequence = 0;
let activeCommand;
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cancellation.abort(new Error(`harness interrupted by ${signal}`));
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    if (activeCommand?.pid) {
      try {
        process.kill(-activeCommand.pid, "SIGKILL");
      } catch {}
    }
  });
async function command(executable, args, log, timeout = 300000) {
  const cwd = process.cwd(),
    at = Date.now();
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w", 0o600);
  const child = spawn(executable, args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  activeCommand = child;
  closeSync(fd);
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, timeout);
  const result = await new Promise((done) => {
    child.once("error", (error) => done({ code: null, error: error.message }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  activeCommand = undefined;
  const record = {
    executable,
    args,
    cwd,
    exitCode: result.code,
    signal: result.signal ?? null,
    error: result.error ?? null,
    timeout: expired,
    wallMs: Date.now() - at,
    log,
  };
  appendFileSync(join(evidence, "commands.jsonl"), JSON.stringify(record) + "\n");
  if (expired) {
    const error = new Error(`command exceeded bounded budget: ${executable}; log ${log}`);
    error.code = "AB_TIMEOUT";
    throw error;
  }
  assert(
    result.code === 0,
    `command failed (${result.code}): ${executable} ${args.join(" ")}; log ${log}`,
  );
  return readFileSync(log, "utf8").trim();
}
function log(name) {
  return join(evidence, `${++sequence}-${name}.log`);
}
try {
  process.chdir(root);
  // Fetch each requested ref first; FETCH_HEAD resolves the fetched remote commit, not a stale local branch.
  for (const arm of arms) {
    if (cancellation.signal.aborted) break;
    const objectRef = /^(?:[a-f0-9]{7,40}|HEAD(?:[~^][0-9]*)?)$/.test(arm.ref);
    await retryTransient(
      () =>
        command(
          "git",
          ["fetch", "origin", ...(objectRef ? [] : [arm.ref.replace(/^origin\//, "")])],
          log("fetch-ref"),
          60000,
        ),
      { attempts: 3 },
    );
    arm.head = await command(
      "git",
      ["rev-parse", "--verify", `${objectRef ? arm.ref : "FETCH_HEAD"}^{commit}`],
      log("resolve-ref"),
      30000,
    );
    assert(/^[a-f0-9]{40}$/.test(arm.head), "full resolved commit SHA");
  }
  if (batch && !cancellation.signal.aborted)
    assert.notEqual(
      arms[0].head,
      arms[1].head,
      "refuse to start: both arms resolve to the same commit SHA",
    );
  writeFileSync(join(evidence, "refs.json"), JSON.stringify(arms, null, 2));
  for (const arm of arms) {
    if (cancellation.signal.aborted) break;
    const prepareAt = Date.now();
    try {
      process.chdir(root);
      const temp = mkdtempSync(join(tmpdir(), "sprout-crew-ab-"));
      const checkout = join(temp, "checkout");
      worktrees.push({ checkout, temp });
      arm.checkout = checkout;
      await command(
        "git",
        ["worktree", "add", "--detach", checkout, arm.head],
        log("worktree-add"),
        30000,
      );
      process.chdir(checkout);
      await command(process.execPath, ["scripts/verify/prepare.mjs", "install"], log("install"));
      await command(
        process.execPath,
        ["scripts/verify/prepare.mjs", "server"],
        log("build-server"),
      );
      await command(
        "bash",
        ["-c", "source scripts/verify/lib/ensure-worker-artifact.sh; ensure_worker_artifact"],
        log("build-worker"),
      );
    } catch (error) {
      arm.error = error.message;
    }
    arm.prepareMs = Date.now() - prepareAt;
  }
  if (batch && !dry && !cancellation.signal.aborted) {
    const probes = [];
    for (const arm of arms) {
      assert(!arm.error, `preflight preparation failed for ${arm.arm}: ${arm.error}`);
      process.chdir(arm.checkout);
      const probe = await runTask({
        task: selected[0],
        repeat: 0,
        arm: arm.arm,
        ref: arm.ref,
        head: arm.head,
        model,
        dry: true,
        timeoutMs,
        directory: join(evidence, `preflight-${arm.arm}`),
        command,
        signal: cancellation.signal,
      });
      probes.push(probe);
      console.log(
        `Preflight ${arm.arm} system prompt hashes: ${JSON.stringify(
          (probe.runs ?? [])
            .filter((run) => run.role === "lead")
            .flatMap((run) => run.systemPromptHashes ?? []),
        )}`,
      );
    }
    writeFileSync(join(evidence, "preflight.json"), JSON.stringify(probes, null, 2));
    preflightHashes(probes);
    assert(
      probes.every((probe) => ["passed", "failed"].includes(probe.status)),
      "refuse to start live batch: preflight task did not complete",
    );
  }
  for (const item of plan) {
    if (cancellation.signal.aborted) break;
    const arm = arms.find((arm) => arm.arm === item.arm);
    const task = selected.find((task) => task.id === item.task);
    if (arm.error) continue;
    process.chdir(arm.checkout);
    const row = await runTaskWithLockRetry(
      {
        task,
        repeat: item.repeat,
        arm: arm.arm,
        ref: arm.ref,
        head: arm.head,
        model,
        dry,
        timeoutMs,
        directory: join(evidence, `${item.repeat}-${arm.arm}-${task.id}`),
        command,
        signal: cancellation.signal,
      },
      runTask,
    );
    row.refPreparationMs = arm.prepareMs;
    record(row);
  }
} catch (error) {
  fatal = error.message;
  console.error(fatal);
  if (!cancellation.signal.aborted) process.exitCode = 1;
} finally {
  for (const item of plan) {
    if (recorded.has(key(item))) continue;
    const arm = arms.find((arm) => arm.arm === item.arm);
    record({
      ...unknownEvidence,
      ...item,
      testedRef: arm.ref,
      head: arm.head ?? null,
      model,
      dry,
      oracle: selected.find((task) => task.id === item.task).oracle,
      category: selected.find((task) => task.id === item.task).category ?? "primary",
      oracleConfig: selected.find((task) => task.id === item.task).oracleConfig ?? {},
      status: "not_run",
      passed: null,
      reason:
        cancellation.signal.reason?.message ?? fatal ?? arm.error ?? "batch did not start item",
    });
  }
  process.chdir(root);
  for (const { checkout, temp } of worktrees.reverse()) {
    try {
      await command(
        "git",
        ["worktree", "remove", "--force", checkout],
        log("worktree-remove"),
        30000,
      );
      rmSync(temp, { recursive: true, force: true });
    } catch (error) {
      console.error(error.message);
      if (!cancellation.signal.aborted) process.exitCode = 1;
    }
  }
}
const summary = summarize(rows, { batch, dry });
writeFileSync(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Evidence: ${evidence}\nLedger: ${out}`);
if (
  !cancellation.signal.aborted &&
  ((batch && summary.reasons.length) || rows.some((r) => !["passed", "failed"].includes(r.status)))
)
  process.exitCode = 1;
