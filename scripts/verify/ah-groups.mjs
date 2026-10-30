import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AH_CHECKS, selectAhGroups, validateAhCoverage } from "./lib/ah-manifest.mjs";
import { killAhNativeCommands } from "./lib/ah-cleanup.mjs";

export async function runAhGroups({
  groups,
  directory,
  commandForGroup,
  deadlineMs = 300_000,
  cleanupGraceMs = 6000,
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = performance.now();
  const active = new Set();
  const outcomes = [];
  let interrupted = null;
  let stopping = false;
  let forceTimer;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    for (const child of active) child.kill(signal);
    forceTimer = setTimeout(() => {
      for (const child of active) child.kill("SIGKILL");
    }, cleanupGraceMs);
  }
  const onInt = () => {
    interrupted ??= "SIGINT";
    stop("SIGINT");
  };
  const onTerm = () => {
    interrupted ??= "SIGTERM";
    stop("SIGTERM");
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  // Fixture wrappers inherit the outer runner's group; only native runners/commands detach.
  try {
    await Promise.all(
      groups.map(async (group) => {
        const groupDirectory = join(directory, group);
        mkdirSync(groupDirectory, { recursive: true, mode: 0o700 });
        const logPath = join(groupDirectory, "fixture.log");
        const fd = openSync(logPath, "w", 0o600);
        const command = commandForGroup?.(group, groupDirectory) ?? {
          file: process.execPath,
          args: ["--import", "tsx", "tests/fixtures/execution-live-e2e.ts", "--group", group],
        };
        const start = performance.now();
        const child = spawn(command.file, command.args, {
          env: { ...process.env, AH_FIXTURE_DIRECTORY: groupDirectory },
          stdio: ["ignore", fd, fd],
        });
        closeSync(fd);
        active.add(child);
        const outcome = {
          group,
          pid: child.pid,
          exitCode: null,
          signal: null,
          durationMs: 0,
          logPath,
          proofPath: join(groupDirectory, "evidence.json"),
          status: "failed",
        };
        outcomes.push(outcome);
        const deadline = setTimeout(() => {
          outcome.error = "group deadline exceeded";
          stop("SIGTERM");
        }, deadlineMs);
        await new Promise((resolveExit) => {
          child.once("error", (error) => {
            outcome.error = error.message;
            resolveExit();
          });
          child.once("exit", (code, signal) => {
            outcome.exitCode = code;
            outcome.signal = signal;
            resolveExit();
          });
        });
        clearTimeout(deadline);
        active.delete(child);
        outcome.durationMs = Math.round(performance.now() - start);
        try {
          if (outcome.exitCode !== 0 || outcome.signal || outcome.error)
            throw new Error(
              outcome.error ?? `child exit=${outcome.exitCode} signal=${outcome.signal}`,
            );
          const evidence = JSON.parse(readFileSync(outcome.proofPath, "utf8"));
          if (evidence.group !== group || evidence.status !== "passed")
            throw new Error("group evidence did not pass");
          validateAhCoverage(group, evidence.checks);
          if (
            group !== "execution" &&
            (evidence.readiness?.length !== 3 ||
              new Set(evidence.readiness).size !== 3 ||
              ["service", "tools", "worker"].some((id) => !evidence.readiness.includes(id)))
          )
            throw new Error("group prerequisites incomplete");
          outcome.status = "passed";
          outcome.checks = evidence.checks;
        } catch (error) {
          outcome.error = error.message;
          stop("SIGTERM");
        }
        try {
          // Also recover detached native groups if the fixture could not finish cleanup.
          const processes = join(groupDirectory, "processes.json");
          if (existsSync(processes)) {
            for (const pid of JSON.parse(readFileSync(processes, "utf8"))) {
              if (!Number.isSafeInteger(pid) || pid <= 1) continue;
              try {
                process.kill(pid, "SIGKILL");
              } catch (error) {
                if (error.code !== "ESRCH") throw error;
              }
            }
          }
          killAhNativeCommands(join(groupDirectory, "private-state"));
        } catch (error) {
          outcome.status = "failed";
          outcome.error = `${outcome.error ?? ""} cleanup: ${error.message}`;
          stop("SIGTERM");
        }
        console.log(
          `${outcome.status === "passed" ? "PASS" : "FAIL"} ah/${group} exit=${outcome.exitCode} signal=${outcome.signal} ${outcome.durationMs}ms log=${logPath}${outcome.error ? ` error=${outcome.error}` : ""}`,
        );
      }),
    );
  } finally {
    clearTimeout(forceTimer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  const exitCode = interrupted
    ? interrupted === "SIGINT"
      ? 130
      : 143
    : outcomes.every((outcome) => outcome.status === "passed")
      ? 0
      : 1;
  const summary = {
    exitCode,
    signal: interrupted,
    durationMs: Math.round(performance.now() - started),
    expectedChecks: groups.flatMap((group) => AH_CHECKS[group]),
    outcomes,
  };
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(`AH evidence: ${join(directory, "summary.json")}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const groups = selectAhGroups(process.argv.slice(2));
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/ah-groups-"));
  const summary = await runAhGroups({ groups, directory });
  process.exitCode = summary.exitCode;
}
