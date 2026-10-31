import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const gates = new Set([
  "a-base",
  "b-tooling",
  "c-data-auth",
  "d-runtime",
  "ad-execution-log-ui",
  "as-p5b-task-pages",
  "p6a-pages",
  "bf-p6b-pages",
  "y-lease-ui",
  "t-machine-worker",
]);
const excluded = new Set([
  ".git",
  ".verify",
  "node_modules",
  "data",
  ".output",
  "dist",
  ".cache",
  ".vite",
  ".nitro",
  ".tanstack",
]);

function inside(root, path) {
  const name = relative(root, path);
  return (
    name === "" ||
    (!name.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      name !== ".." &&
      !isAbsolute(name))
  );
}

function git(root, args, optional = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  if (optional && result.status === 1) return null;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function copy(source, target) {
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    mode: constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
  });
}

function privateIndex(original, root) {
  const directory = join(root, ".git");
  const index = git(original, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (existsSync(index)) copy(index, join(directory, "index"));
  for (const name of readdirSync(dirname(index)))
    if (name.startsWith("sharedindex.")) copy(join(dirname(index), name), join(directory, name));
  const common = git(original, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const exclude = join(common, "info/exclude");
  if (existsSync(exclude)) copy(exclude, join(directory, "info/exclude"));
  for (const key of [
    "core.filemode",
    "core.ignorecase",
    "core.symlinks",
    "core.autocrlf",
    "core.eol",
    "core.excludesfile",
  ]) {
    const value = git(original, ["config", "--get", key], true);
    if (value !== null) git(root, ["config", "--local", key, value]);
  }
  git(root, ["config", "--local", "core.fsmonitor", "false"]);
  git(root, ["config", "--local", "core.hooksPath", join(directory, "hooks-disabled")]);
}

function processSnapshot(withEnvironment = false) {
  const result = spawnSync(
    "ps",
    process.platform === "linux"
      ? ["-e", "-o", "pid=,ppid=,stat=,lstart=,args=", ...(withEnvironment ? ["eww"] : [])]
      : [...(withEnvironment ? ["eww"] : []), "-axo", "pid=,ppid=,stat=,lstart=,command="],
    {
      encoding: "utf8",
      detached: true,
      timeout: 3000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Cannot inspect sandbox descendants: status=${result.status} signal=${result.signal} error=${result.error?.message ?? "none"}; ${result.stderr}`,
    );
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s+(.*)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            state: match[3],
            started: match[4],
            command: match[5],
          },
        ]
      : [];
  });
}

function descendants(marker) {
  const known = new Map();
  function scan(withEnvironment = false) {
    const rows = processSnapshot(withEnvironment);
    const owned = new Set([process.pid]);
    for (const row of rows) {
      if (
        known.get(row.pid) === row.started ||
        (withEnvironment && row.command.split(/\s+/).includes(marker))
      )
        owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
    }
    const live = rows.filter(
      (row) => row.pid !== process.pid && owned.has(row.pid) && !row.state.startsWith("Z"),
    );
    for (const row of live) known.set(row.pid, row.started);
    return live;
  }
  function signal(signal, withEnvironment = false) {
    for (const row of scan(withEnvironment).reverse()) {
      try {
        process.kill(row.pid, signal);
      } catch (error) {
        // 行是刚扫出来的，ESRCH 是它已退出，EPERM 是它已被回收。
        if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      }
    }
  }
  return { scan, signal };
}

async function cloneDependencies(original, root, environment, run) {
  for (const name of ["node_modules", ".output", "dist"]) {
    if (!existsSync(join(original, name))) continue;
    const source = realpathSync(join(original, name));
    const args =
      process.platform === "darwin"
        ? ["-cR", source, join(root, name)]
        : ["--reflink=auto", "-R", source, join(root, name)];
    const outcome = await run("cp", args);
    if (outcome.signal || outcome.code !== 0) throw new Error(`Cannot privately copy ${name}`);
  }
  function rebase(directory, sourceBase, destinationBase) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if ([".vite", ".vite-temp", ".cache"].includes(entry.name)) {
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(path);
        const sourcePath = join(sourceBase, relative(destinationBase, path));
        const target = resolve(dirname(sourcePath), link);
        const privateTarget = inside(sourceBase, target)
          ? join(destinationBase, relative(sourceBase, target))
          : inside(original, target)
            ? join(root, relative(original, target))
            : null;
        if (privateTarget && resolve(dirname(path), link) === privateTarget) continue;
        rmSync(path);
        if (privateTarget) symlinkSync(relative(dirname(path), privateTarget), path);
        else copy(target, path);
      } else if (entry.isDirectory()) rebase(path, sourceBase, destinationBase);
      else if (basename(directory) === ".bin" && entry.isFile()) {
        const bytes = readFileSync(path);
        if (!bytes.includes(0)) {
          const text = bytes.toString("utf8");
          const rebased = text.replaceAll(sourceBase, destinationBase);
          if (text !== rebased) writeFileSync(path, rebased);
        }
      }
    }
  }
  for (const name of ["node_modules", ".output", "dist"])
    if (existsSync(join(root, name)))
      rebase(join(root, name), realpathSync(join(original, name)), join(root, name));
  mkdirSync(join(root, "node_modules/.vite"), { recursive: true });
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
  delete environment.NODE_PATH;
}

function exportEvidence(root, original, gate, result, durationMs) {
  const target = join(original, ".verify", gate);
  mkdirSync(target, { recursive: true });
  const exported = [];
  function visit(source, destination, prefix) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const path = join(source, entry.name);
      if (entry.isDirectory() && !/^(state|pi-sessions|agent|private|data)$/.test(entry.name))
        visit(path, join(destination, entry.name), `${prefix}${entry.name}/`);
      else if (
        entry.isFile() &&
        (/\.(log|png)$/.test(entry.name) ||
          ["evidence.json", "model-mode.json"].includes(entry.name))
      ) {
        mkdirSync(destination, { recursive: true });
        copy(path, join(destination, entry.name));
        exported.push(`${prefix}${entry.name}`);
      }
    }
  }
  const state = join(root, ".verify");
  if (existsSync(state))
    for (const entry of readdirSync(state, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === gate) visit(join(state, entry.name), target, "");
      else if (entry.name.startsWith(`${gate}-`))
        visit(join(state, entry.name), join(target, entry.name), `${entry.name}/`);
      else if (entry.name === "runs")
        visit(join(state, entry.name), join(target, "preparation"), "preparation/");
    }
  writeFileSync(
    join(target, "sandbox-artifacts.json"),
    `${JSON.stringify({ gate, ...result, durationMs, files: exported.sort((a, b) => a.localeCompare(b)) }, null, 2)}\n`,
  );
  console.log(`SANDBOX evidence=${join(target, "sandbox-artifacts.json")}`);
}

export async function runSandbox(args) {
  const [option, gate, separator, script, ...extra] = args;
  if (option !== "--gate" || !gates.has(gate) || separator !== "--" || !script || extra.length)
    throw new Error("Usage: sandbox.mjs --gate <supported gate> -- <gateScriptPath>");
  const original = realpathSync(process.cwd());
  const selected = resolve(original, script);
  if (
    !inside(original, selected) ||
    !existsSync(selected) ||
    !inside(original, realpathSync(selected))
  )
    throw new Error("Gate script must be a file inside the original working tree");
  const started = performance.now();
  const parent = join(original, ".verify/sandboxes");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `${gate}-`));
  const token = randomUUID();
  const environment = {
    ...process.env,
    SPROUT_VERIFY_SANDBOX_ID: token,
    SPROUT_VERIFY_PREPARED_ONLY: "0",
  };
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
  const tree = descendants(`SPROUT_VERIFY_SANDBOX_ID=${token}`);
  let interrupted = null;
  let escalation;
  let monitor;
  const stop = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    tree.signal(signal, true);
    escalation = setTimeout(() => tree.signal("SIGKILL", true), 1500);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  async function run(command, commandArgs) {
    if (interrupted) return { code: null, signal: interrupted };
    const child = spawn(command, commandArgs, { cwd: root, env: environment, stdio: "inherit" });
    return new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
  }
  let result = { code: 1, signal: null };
  try {
    const cloned = await run("git", [
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      original,
      root,
    ]);
    if (cloned.code !== 0 || cloned.signal) throw new Error("Cannot create private Git metadata");
    for (const entry of readdirSync(original)) {
      if (!excluded.has(entry)) copy(join(original, entry), join(root, entry));
    }
    privateIndex(original, root);
    const runId = `sandbox-${token}`;
    const runDirectory = join(root, ".verify/runs", runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, "context.json"),
      `${JSON.stringify({ root, runId, ownerPid: process.pid })}\n`,
    );
    environment.SPROUT_VERIFY_RUN_DIR = runDirectory;
    const privateData = join(root, ".verify/private");
    mkdirSync(privateData, { recursive: true });
    Object.assign(environment, {
      DATABASE_URL: join(privateData, "sprout.sqlite"),
      SPROUT_PI_DATA_DIR: join(privateData, "pi"),
      SPROUT_REPO_DIR: join(privateData, "repos"),
      XDG_CACHE_HOME: join(privateData, "cache"),
      npm_config_cache: join(privateData, "npm-cache"),
      SPROUT_VERIFY_FULL_SUITE: gate === "b-tooling" ? "1" : "0",
    });
    const originalAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
    const agent = join(privateData, "agent");
    mkdirSync(join(agent, "bin"), { recursive: true });
    let pi = join(originalAgent, "bin/pi");
    const releases = join(originalAgent, "install/releases");
    if (existsSync(releases)) {
      for (const version of readdirSync(releases).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      )) {
        const cli = join(
          releases,
          version,
          "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        );
        if (existsSync(cli)) {
          pi = cli;
          break;
        }
      }
    }
    if (existsSync(pi)) symlinkSync(realpathSync(pi), join(agent, "bin/pi"));
    for (const name of ["auth.json", "models.json", "settings.json"]) {
      if (existsSync(join(originalAgent, name))) copy(join(originalAgent, name), join(agent, name));
    }
    environment.PI_CODING_AGENT_DIR = agent;
    for (const [prefix, id] of [
      ["SPROUT_EXECUTION_SCENES", "ad-execution-log-ui"],
      ["SPROUT_LEASE_SCENES", "y-lease-ui"],
    ]) {
      if (gate !== id) continue;
      environment[`${prefix}_LOG_DIR`] = join(root, ".verify", gate);
      environment[`${prefix}_EVIDENCE`] = join(root, ".verify", gate, "evidence");
    }
    await cloneDependencies(original, root, environment, run);
    if (!interrupted) {
      tree.scan();
      monitor = setInterval(() => tree.scan(), 250);
      result = await run("bash", [join(root, relative(original, selected))]);
    }
    result.signal = interrupted ?? result.signal;
    return result;
  } catch (error) {
    if (!interrupted) throw error;
    result = { code: null, signal: interrupted };
    return result;
  } finally {
    clearInterval(monitor);
    clearTimeout(escalation);
    try {
      tree.signal("SIGKILL", true);
      exportEvidence(
        root,
        original,
        gate,
        { ...result, signal: interrupted ?? result.signal },
        Math.round(performance.now() - started),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}
