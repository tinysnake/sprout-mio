#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { NATIVE_GATE_WEIGHTS, NATIVE_LANE_BUDGET } from "./lib/native-lanes.mjs";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const verifyDirectory = join(root, "scripts", "verify");
const verifyStateDirectory = join(root, ".verify");
const runsDirectory = join(verifyStateDirectory, "runs");
const forceStopMs = 10_000;
const tailLines = 40;
const tailCharacters = 4_000;

const usage = `Usage: pnpm verify [--only <id>[,<id>...]] [--help]

Runs top-level scripts/verify/*.sh scripts in lexical order, with the five fixed
native gates gathered into one bounded batch. Other scripts remain sequential.
A failing script does not stop later scripts. The command exits 1 when any
script fails.

Options:
  --only <ids>  Run exactly these comma-separated script ids (file names without .sh).
  --help        Print this help without creating a run directory or running scripts.
`;

class UsageError extends Error {}

function discoverScripts() {
  if (!existsSync(verifyDirectory)) return [];
  return readdirSync(verifyDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
    .map((entry) => ({
      id: entry.name.slice(0, -".sh".length),
      file: join(verifyDirectory, entry.name),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function parseArguments(rawArguments) {
  const args = [...rawArguments];
  if (args[0] === "--") args.shift();

  let only = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true, only: null };
    if (argument === "--only") {
      if (only !== null) throw new UsageError("--only may be passed only once");
      const value = args[++index];
      if (value === undefined) throw new UsageError("--only requires a value");
      only = value;
      continue;
    }
    if (argument.startsWith("--only=")) {
      if (only !== null) throw new UsageError("--only may be passed only once");
      only = argument.slice("--only=".length);
      continue;
    }
    throw new UsageError(`unknown argument: ${argument}`);
  }

  if (only === null) return { help: false, only: null };

  const selected = only.split(",").map((id) => id.trim());
  if (selected.length === 0 || selected.some((id) => id === "")) {
    throw new UsageError("--only requires at least one non-empty script id");
  }
  const seen = new Set();
  for (const id of selected) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new UsageError(`invalid script id: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new UsageError(`duplicate script id: ${id}`);
    seen.add(id);
  }

  const available = new Set(discoverScripts().map((script) => script.id));
  const unknown = selected.filter((id) => !available.has(id));
  if (unknown.length > 0) throw new UsageError(`unknown script id: ${unknown.join(", ")}`);

  return { help: false, only: selected };
}

function createRunDirectory() {
  mkdirSync(runsDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `${stamp}-${process.pid}-${attempt}`;
    const directory = join(runsDirectory, id);
    try {
      mkdirSync(directory);
      return { id, directory };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not create a unique verification run directory");
}

function cleanVerificationDatabases(selection) {
  if (!existsSync(verifyStateDirectory)) return;
  const units =
    selection === null
      ? readdirSync(verifyStateDirectory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "runs")
          .map((entry) => entry.name)
      : selection;
  for (const unit of units) {
    rmSync(join(verifyStateDirectory, unit, "verification.sqlite"), { force: true });
  }
}

function readLogTail(logPath) {
  try {
    const text = readFileSync(logPath, "utf8");
    const lines = text.split("\n");
    const tail = lines.slice(-tailLines).join("\n").slice(-tailCharacters);
    return tail.trimEnd();
  } catch {
    return "";
  }
}

function formatDuration(durationMs) {
  return `${Math.round(durationMs)}ms`;
}

/** @type {{ signal: string | null, exitCode: number | null }} */
const interrupted = { signal: null, exitCode: null };
const activeChildren = new Set();
let cleanup = Promise.resolve();

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function handleSignal(signal) {
  if (interrupted.signal !== null) return;
  interrupted.signal = signal;
  interrupted.exitCode = signal === "SIGINT" ? 130 : 143;
  const deadline = performance.now() + forceStopMs;
  const descendants = new Set([...activeChildren].map((child) => child.pid).filter(Boolean));
  // Remember detached descendants before their launcher can exit and reparent them.
  function remainingProcesses() {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,stat="], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (result.status !== 0) return [...descendants];
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, parent, state] = line.trim().split(/\s+/);
        return { pid: Number(pid), parent: Number(parent), state };
      });
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    } while (changed);
    return rows
      .filter((row) => descendants.has(row.pid) && !row.state?.startsWith("Z"))
      .map((row) => row.pid);
  }
  remainingProcesses();
  for (const child of activeChildren) {
    if (child.pid) signalProcessGroup(child.pid, signal);
  }
  cleanup = new Promise((resolveCleanup) => {
    let forced = false;
    const check = () => {
      const remaining = remainingProcesses();
      if (remaining.length === 0 && activeChildren.size === 0) {
        resolveCleanup();
        return;
      }
      if (performance.now() >= deadline) {
        // Give launchers the entire grace period to forward cleanup to private groups.
        for (const pid of remaining) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        for (const child of activeChildren) {
          if (child.pid) signalProcessGroup(child.pid, "SIGKILL");
        }
        if (forced && performance.now() >= deadline + 1000) {
          resolveCleanup();
          return;
        }
        forced = true;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

function runScript(script, runDirectory, environment = {}) {
  return new Promise((resolveOutcome) => {
    const relativePath = relative(root, script.file).split("\\").join("/");
    const logPath = join(runDirectory, `${script.id}.log`);
    const logDescriptor = openSync(logPath, "w");
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const outcome = {
      id: script.id,
      path: relativePath,
      status: "failed",
      exitCode: null,
      signal: null,
      startedAt,
      durationMs: 0,
      logPath,
    };

    console.log(`RUN ${script.id} ${relativePath}`);

    let settled = false;
    const finish = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      closeSync(logDescriptor);
      outcome.durationMs = Math.round(performance.now() - started);
      outcome.exitCode = code;
      outcome.signal = signal;
      outcome.status =
        code === 0 && signal === null && !spawnError && interrupted.signal === null
          ? "passed"
          : "failed";
      activeChildren.delete(child);
      if (outcome.status === "passed") {
        console.log(`PASS ${script.id} ${relativePath} ${formatDuration(outcome.durationMs)}`);
      } else {
        const reasons = [];
        if (spawnError !== undefined) reasons.push(`error=${spawnError.message}`);
        if (signal !== null) reasons.push(`signal=${signal}`);
        if (code !== null && (code !== 0 || interrupted.signal !== null))
          reasons.push(`exit=${code}`);
        if (interrupted.signal !== null) reasons.push(`interrupted=${interrupted.signal}`);
        if (reasons.length === 0) reasons.push(`exit=${code}`);
        console.log(
          `FAIL ${script.id} ${relativePath} ${formatDuration(outcome.durationMs)} ${reasons.join(" ")}`,
        );
        const tail = readLogTail(logPath);
        if (tail !== "") {
          console.log(`--- tail ${relative(root, logPath)} ---`);
          console.log(tail);
          console.log(`--- end tail ---`);
        }
      }
      resolveOutcome(outcome);
    };

    const child = spawn(script.command ?? "bash", script.args ?? [script.file], {
      cwd: root,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      env: {
        ...process.env,
        SPROUT_PI_ENABLED: "false",
        SPROUT_VERIFY_RUN_DIR: runDirectory,
        ...environment,
      },
    });
    activeChildren.add(child);
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

async function runNativeBatch(scripts, runDirectory) {
  console.log(
    `Native batch gates=${scripts.map((script) => script.id).join(",")} fixtureBudget=${NATIVE_LANE_BUDGET}`,
  );
  const preparationStarted = performance.now();
  for (const kind of ["install", "server", "worker"]) {
    if (interrupted.signal !== null) return [];
    const file = join(verifyDirectory, "prepare.mjs");
    const preparation = await runScript(
      {
        id: `prepare-${kind}`,
        file,
        command: process.execPath,
        args: [file, kind],
      },
      runDirectory,
      {
        ...(kind === "install" ? {} : { NODE_ENV: "production" }),
        SPROUT_VERIFY_PREPARED_ONLY: "0",
      },
    );
    if (interrupted.signal !== null) return [];
    if (preparation.status !== "passed") {
      return scripts.map((script) => {
        const logPath = join(runDirectory, `${script.id}.log`);
        writeFileSync(
          logPath,
          `Blocked by ${kind} preparation; exit=${preparation.exitCode} signal=${preparation.signal} log=${preparation.logPath}\n`,
        );
        console.log(`FAIL ${script.id} blocked by ${kind} preparation log=${logPath}`);
        return {
          id: script.id,
          path: relative(root, script.file).split("\\").join("/"),
          status: "failed",
          exitCode: null,
          signal: null,
          startedAt: new Date().toISOString(),
          durationMs: 0,
          logPath,
        };
      });
    }
  }
  console.log(`Native preparation total=${formatDuration(performance.now() - preparationStarted)}`);
  const pending = [...scripts];
  const running = new Map();
  const outcomes = [];
  let used = 0;
  while (pending.length || running.size) {
    if (interrupted.signal === null) {
      let index;
      while (
        (index = pending.findIndex(
          (script) => used + NATIVE_GATE_WEIGHTS[script.id] <= NATIVE_LANE_BUDGET,
        )) !== -1
      ) {
        const [script] = pending.splice(index, 1);
        used += NATIVE_GATE_WEIGHTS[script.id];
        running.set(
          script.id,
          runScript(script, runDirectory, {
            NODE_ENV: "production",
            SPROUT_VERIFY_PREPARED_ONLY: "1",
          }),
        );
      }
    }
    if (running.size === 0) break;
    const outcome = await Promise.race(running.values());
    running.delete(outcome.id);
    used -= NATIVE_GATE_WEIGHTS[outcome.id];
    outcomes.push(outcome);
  }
  return outcomes;
}

function writeReport(runDirectory, report) {
  const reportPath = join(runDirectory, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function printSummary(outcomes, totalDurationMs, reportPath) {
  console.log("Slowest first");
  for (const outcome of [...outcomes].sort((left, right) => right.durationMs - left.durationMs)) {
    console.log(
      `  ${formatDuration(outcome.durationMs)} ${outcome.status === "passed" ? "PASS" : "FAIL"} ${outcome.id}`,
    );
  }
  console.log(`Verification total=${formatDuration(totalDurationMs)}`);
  console.log(`Verification report=${relative(root, reportPath).split("\\").join("/")}`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`FAIL ${error.message}`);
    console.error("");
    console.error(usage);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(usage);
    return 0;
  }

  const allScripts = discoverScripts();
  const selected =
    parsed.only === null
      ? allScripts
      : allScripts.filter((script) => parsed.only.includes(script.id));

  const run = createRunDirectory();
  writeFileSync(
    join(run.directory, "context.json"),
    `${JSON.stringify({ root, runId: run.id, ownerPid: process.pid })}\n`,
  );
  const startedAt = new Date().toISOString();
  const runStarted = performance.now();
  const outcomes = [];

  cleanVerificationDatabases(parsed.only);

  const nativeScripts = selected.filter((script) => Object.hasOwn(NATIVE_GATE_WEIGHTS, script.id));
  let nativeDispatched = false;
  for (const script of selected) {
    if (interrupted.signal !== null) break;
    if (Object.hasOwn(NATIVE_GATE_WEIGHTS, script.id)) {
      if (nativeDispatched) continue;
      nativeDispatched = true;
      outcomes.push(...(await runNativeBatch(nativeScripts, run.directory)));
    } else outcomes.push(await runScript(script, run.directory));
  }
  await cleanup;
  outcomes.sort(
    (left, right) =>
      selected.findIndex((script) => script.id === left.id) -
      selected.findIndex((script) => script.id === right.id),
  );

  const totalDurationMs = Math.round(performance.now() - runStarted);
  const failed = outcomes.filter((outcome) => outcome.status !== "passed").length;
  const report = {
    runId: run.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: totalDurationMs,
    selection: parsed.only,
    interrupted:
      interrupted.signal === null
        ? null
        : { signal: interrupted.signal, exitCode: interrupted.exitCode },
    count: outcomes.length,
    passed: outcomes.length - failed,
    failed,
    outcomes,
  };
  const reportPath = writeReport(run.directory, report);

  printSummary(outcomes, totalDurationMs, reportPath);

  if (selected.length === 0) {
    console.log("FAIL no verification scripts found");
    return 1;
  }

  console.log(`Verification scripts=${report.count} failed=${failed}`);

  if (interrupted.signal !== null) return interrupted.exitCode;
  return failed === 0 ? 0 : 1;
}

const exitCode = await main();
process.exitCode = exitCode;
