#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const artifacts = {
  install: { args: ["install", "--frozen-lockfile"], outputs: ["node_modules"], inputs: [] },
  server: {
    args: ["build"],
    outputs: [".output/server/index.mjs", ".output/public/_shell.html", ".output/public/assets"],
    inputs: ["src", "public", "drizzle"],
  },
  worker: {
    args: ["worker:build"],
    outputs: ["dist/worker/main.js", "dist/worker/runner.js"],
    inputs: ["src", "public", "drizzle"],
  },
  extension: {
    args: ["extension:build"],
    outputs: ["dist/extension/main.js"],
    inputs: ["src", "public", "drizzle"],
  },
};

function currentRun() {
  const value = process.env.SPROUT_VERIFY_RUN_DIR;
  if (value === undefined) return null;
  try {
    const directory = realpathSync(value);
    const context = JSON.parse(readFileSync(join(directory, "context.json"), "utf8"));
    if (
      dirname(directory) !== join(root, ".verify/runs") ||
      context.root !== root ||
      context.runId !== basename(directory) ||
      !Number.isInteger(context.ownerPid) ||
      context.ownerPid <= 0
    )
      throw new Error("root, run id or owner mismatch");
    process.kill(context.ownerPid, 0);
    return directory;
  } catch (error) {
    throw new Error(`Invalid verification run context: ${error.message}`);
  }
}

function isCompilationInput(name) {
  return /^(NODE_ENV$|NODE_OPTIONS$|VITEST$|VITE_|NITRO_(?!PORT$|HOST$)|ROLLUP_|TS_NODE_|TSC_)/.test(
    name,
  );
}

function fingerprint(kind, environment) {
  const hash = createHash("sha256");
  const add = (name, value) => {
    hash.update(name);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  };
  function visit(path) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      add(path, "missing");
      return;
    }
    if (lstatSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(`${path}/${entry}`);
    } else add(path, readFileSync(absolute));
  }
  const dependencyInputs = readdirSync(root).filter((name) =>
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/.test(name),
  );
  const compilerInputs = readdirSync(root).filter((name) =>
    /^(vite\.config\.|tsconfig.*\.json$|\.env(?:\.|$))/.test(name),
  );
  for (const input of [
    ...dependencyInputs,
    ...(kind === "install" ? [] : compilerInputs),
    ...artifacts[kind].inputs,
    "scripts/verify/prepare.mjs",
  ].sort((left, right) => left.localeCompare(right)))
    visit(input);
  add("recipe", JSON.stringify(artifacts[kind]));
  add("node", process.version);
  if (kind !== "install") {
    for (const key of Object.keys(environment).filter(isCompilationInput).sort())
      add(key, environment[key]);
  }
  return hash.digest("hex");
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function produce(args, environment, logPath) {
  const started = performance.now();
  const descriptor = openSync(logPath, "a");
  let child;
  try {
    child = spawn("pnpm", args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  let interrupted = null;
  let escalation;
  const kill = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = (signal) => {
    if (interrupted !== null) return;
    interrupted = signal;
    kill(signal);
    escalation = setTimeout(() => kill("SIGKILL"), 2000);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveResult({ code, signal }));
    });
    const signal = interrupted ?? result.signal;
    return {
      ...result,
      interrupted,
      exitCode: signal ? 128 + (constants.signals[signal] ?? 1) : (result.code ?? 1),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(escalation);
    kill("SIGKILL");
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

async function main() {
  const [kind, option, ...extra] = process.argv.slice(2);
  if (
    !Object.hasOwn(artifacts, kind) ||
    (option !== undefined && option !== "--fresh") ||
    extra.length
  )
    throw new Error(
      "Usage: node scripts/verify/prepare.mjs install|server|worker|extension [--fresh]",
    );
  const runDirectory = currentRun();
  const environment = { ...process.env };
  if (kind === "server") {
    environment.NODE_ENV = "production";
    delete environment.BETTER_AUTH_SECRET;
  }
  const requiredOutputs = artifacts[kind].outputs.map((path) => join(root, path));
  const receiptPath = runDirectory && join(runDirectory, `${kind}.json`);
  const receipt = receiptPath && readReceipt(receiptPath);
  if (
    option !== "--fresh" &&
    receipt?.kind === kind &&
    receipt.root === root &&
    receipt.fingerprint === fingerprint(kind, environment) &&
    typeof receipt.logPath === "string" &&
    dirname(receipt.logPath) === runDirectory &&
    existsSync(receipt.logPath) &&
    requiredOutputs.every(existsSync) &&
    JSON.stringify(receipt.requiredOutputs) === JSON.stringify(requiredOutputs)
  ) {
    console.log(
      `REUSE ${kind} current-run inputs and required outputs checked; original log=${receipt.logPath} original durationMs=${receipt.durationMs}`,
    );
    process.stdout.write(readFileSync(receipt.logPath));
    return 0;
  }
  if (process.env.SPROUT_VERIFY_PREPARED_ONLY === "1")
    throw new Error(
      `Prepared-only verification forbids producing ${kind}; current-run receipt or outputs do not match`,
    );
  if (receiptPath) rmSync(receiptPath, { force: true });
  if (kind === "install") {
    if (runDirectory)
      for (const artifact of Object.keys(artifacts))
        rmSync(join(runDirectory, `${artifact}.json`), { force: true });
    for (const output of ["node_modules", "dist", ".output"])
      rmSync(join(root, output), { recursive: true, force: true });
  }
  mkdirSync(join(root, ".verify"), { recursive: true });
  const logDirectory = runDirectory ?? mkdtempSync(join(root, ".verify/preparation-"));
  const logPath = join(logDirectory, `${kind}-${randomUUID()}.log`);
  writeFileSync(logPath, "");
  console.log(`PREPARE ${kind} pnpm ${artifacts[kind].args.join(" ")} log=${logPath}`);
  const result = await produce(artifacts[kind].args, environment, logPath);
  process.stdout.write(readFileSync(logPath));
  if (result.exitCode !== 0) {
    console.error(
      `FAILED ${kind} code=${result.code} signal=${result.signal} interrupted=${result.interrupted} durationMs=${result.durationMs}`,
    );
    return result.exitCode;
  }
  if (!requiredOutputs.every(existsSync))
    throw new Error(`Missing required ${kind} output after successful pnpm command`);
  if (receiptPath)
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ kind, root, fingerprint: fingerprint(kind, environment), logPath, durationMs: result.durationMs, requiredOutputs }, null, 2)}\n`,
    );
  console.log(`PREPARED ${kind} durationMs=${result.durationMs}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
