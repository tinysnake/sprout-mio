import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { taskSet, summarize, unknownEvidence } from "./core.mjs";
import { runTask } from "./run-task.mjs";

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
let sequence = 0;
let activeCommand;
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cancellation.abort(new Error(`harness interrupted by ${signal}`));
    process.exitCode = 130;
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
  assert(
    !expired && result.code === 0,
    `command failed (${result.code}): ${executable} ${args.join(" ")}; log ${log}`,
  );
  return readFileSync(log, "utf8").trim();
}
function log(name) {
  return join(evidence, `${++sequence}-${name}.log`);
}
try {
  for (const arm of arms) {
    if (cancellation.signal.aborted) break;
    const prepareAt = Date.now();
    try {
      process.chdir(root);
      arm.head = await command(
        "git",
        ["rev-parse", "--verify", `${arm.ref}^{commit}`],
        log("resolve-ref"),
        30000,
      );
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
  runRounds: for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const arm of arms) {
      for (const task of selected) {
        if (cancellation.signal.aborted) break runRounds;
        let row;
        if (arm.error)
          row = {
            ...unknownEvidence,
            arm: arm.arm,
            task: task.id,
            repeat,
            ref: arm.ref,
            testedRef: arm.ref,
            head: arm.head ?? null,
            model,
            dry,
            oracle: task.oracle,
            status: "errored",
            passed: null,
            error: { message: arm.error },
            settleMs: 0,
            wallClockPerPhase: {
              prepare: arm.prepareMs,
              startup: 0,
              sendTask: 0,
              settle: 0,
              judge: 0,
            },
          };
        else {
          process.chdir(arm.checkout);
          row = await runTask({
            task,
            repeat,
            arm: arm.arm,
            ref: arm.ref,
            head: arm.head,
            model,
            dry,
            timeoutMs,
            directory: join(evidence, `${repeat}-${arm.arm}-${task.id}`),
            command,
            signal: cancellation.signal,
          });
          row.refPreparationMs = arm.prepareMs;
        }
        appendFileSync(out, JSON.stringify(row) + "\n", { mode: 0o600 });
        rows.push(row);
        console.log(
          `${row.status.toUpperCase()} ${arm.arm} ${task.id} repeat=${repeat} out=${out}`,
        );
      }
    }
  }
} finally {
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
      process.exitCode = 1;
    }
  }
}
summarize(rows);
console.log(`Evidence: ${evidence}\nLedger: ${out}`);
if (rows.some((r) => r.status === "errored" || r.status === "timeout")) process.exitCode = 1;
