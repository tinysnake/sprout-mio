import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { unitExecution, unitShardFiles, validateUnitTargets } from "./lib/test-targets.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const [target, ...args] = process.argv.slice(2);
const inventory = validateUnitTargets(root);
let list = false;
let shard;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--list" && !list) list = true;
  else if (args[i] === "--shard" && args[i + 1] && shard === undefined) shard = args[++i];
  else throw new Error(`Unknown unit option: ${args[i]}`);
}
if (!Object.hasOwn(inventory, target) || (shard && target !== "ci"))
  throw new Error("Usage: test-target.mjs <ci|local> [--shard <1..4>/4] [--list]");
const files = unitShardFiles(inventory[target], shard);
if (files.length === 0) throw new Error("Unit selection must not be empty");
if (list) console.log(JSON.stringify({ target, shard: shard ?? null, files }, null, 2));
else {
  console.log(`RUN unit target=${target} shard=${shard ?? "all"} files=${files.length}`);
  const startedAt = new Date().toISOString();
  const environment = { ...process.env, NODE_ENV: "test", MCP_EVERYTHING: "0" };
  const directory = mkdtempSync(join(tmpdir(), `sprout-${target}-unit-`));
  const executionReport = join(directory, "execution.json");
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  if (target === "ci") {
    const agent = join(directory, "agent");
    mkdirSync(agent);
    for (const name of ["PI_MCP_MODULE", "PI_BIN", "SPROUT_PI_RUNNER", "SPROUT_PI_COMMAND"])
      delete environment[name];
    Object.assign(environment, {
      PI_CODING_AGENT_DIR: agent,
      SPROUT_PI_ENABLED: "false",
      SPROUT_VERIFY_TARGET: "ci",
      DATABASE_URL: join(directory, "sprout.sqlite"),
      SPROUT_PI_DATA_DIR: join(directory, "pi"),
      SPROUT_REPO_DIR: join(directory, "repos"),
      XDG_CACHE_HOME: join(directory, "cache"),
      npm_config_cache: join(directory, "npm-cache"),
      no_proxy: "localhost,127.0.0.1,::1",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  }
  const processGroup = target === "ci" && process.platform !== "win32";
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "--maxWorkers",
      target === "ci" ? "2" : "4",
      ...files,
      ...(target === "ci"
        ? ["--reporter=default", "--reporter=json", `--outputFile.json=${executionReport}`]
        : []),
    ],
    { cwd: root, stdio: "inherit", env: environment, detached: processGroup },
  );
  let interrupted;
  let timedOut = false;
  let forceTimer;
  const stop = (signal) => {
    if (!child.pid) return;
    try {
      if (processGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const forceStop = (signal) => {
    stop(signal);
    forceTimer ??= setTimeout(() => stop("SIGKILL"), 3000);
  };
  const timer =
    target === "ci"
      ? setTimeout(() => {
          timedOut = true;
          console.error("Unit command exceeded 300 seconds");
          forceStop("SIGTERM");
        }, 300_000)
      : undefined;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      interrupted ??= signal;
      if (processGroup) forceStop(signal);
      else stop(signal);
    });
  child.once("error", (error) => console.error(error.message));
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (processGroup) stop("SIGKILL");
    let execution;
    let executionError;
    if (target === "ci") {
      try {
        execution = unitExecution(files, JSON.parse(readFileSync(executionReport, "utf8")), root);
        if (!execution.complete)
          executionError = "Executed unit file inventory does not match the selected inventory";
        else if (!execution.success) executionError = "Unit execution report did not succeed";
      } catch {
        executionError = "Missing or invalid unit execution JSON";
      }
      if (executionError) console.error(executionError);
    }
    const reportDirectory = join(root, ".verify/units");
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(
      join(reportDirectory, `${target}-${shard?.replace("/", "-of-") ?? "all"}.json`),
      JSON.stringify(
        {
          target,
          shard: shard ?? null,
          files,
          execution,
          executionError,
          startedAt,
          finishedAt: new Date().toISOString(),
          code,
          signal,
          interrupted: interrupted ?? null,
          timedOut,
        },
        null,
        2,
      ) + "\n",
    );
    const termination = interrupted ?? signal;
    process.exitCode = timedOut
      ? 1
      : termination === "SIGINT"
        ? 130
        : termination === "SIGTERM"
          ? 143
          : code !== 0
            ? (code ?? 1)
            : executionError
              ? 1
              : 0;
  });
}
