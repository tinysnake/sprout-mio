#!/usr/bin/env node
/**
 * A persistent, private P4b playground with a real fencing + Human force-reclaim scenario.
 *
 * Isolation: fresh private state directory, `listen(0)` port (3000 refused), private SQLite,
 * private Worker identity and a fresh account. Nothing is reused between runs.
 *
 * Fencing is produced only by real means, in the order the product produces it:
 *   1. the holder instance starts a remote `file_read` on a named pipe inside the Machine's
 *      project directory, so the Worker really blocks inside `open(2)`: a dispatched,
 *      non-terminal execution with no drain;
 *   2. the same holder requests `release` (the page's own action). Because an un-drained
 *      dispatched execution exists, the receipt stays `pending`, the lease parks in
 *      `fencing`, and only the Worker's fence acknowledgement could advance it;
 *   3. the Machine's real Worker process group is SIGKILLed, so that acknowledgement can
 *      never arrive, and after the stale window the server's own expiry marks the execution
 *      `unknown` / `worker_lost` with `drained_at` NULL.
 * This script never writes a lease, receipt or execution row: no drain is faked, nothing is
 * marked drained, and no state is edited to imitate fencing.
 *
 * stdout carries progress and file paths only; credentials exist solely inside the
 * `review-info.json` written for the Human (mode 0600).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const requireStart = createRequire(import.meta.resolve("@tanstack/react-start"));
const requireClient = createRequire(
  requireStart.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON, toJSON } = requireClient("seroval");

process.umask(0o077);
process.env.NO_PROXY = "127.0.0.1,localhost,::1";
process.env.no_proxy = process.env.NO_PROXY;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "sprout-p4b-review3-")));
// The Human-facing document outlives the throwaway state directory, so cleanup can remove the
// private SQLite and Worker state while the instructions stay readable.
const infoDir = join(tmpdir(), "p4b-reviewenv3");
mkdirSync(infoDir, { recursive: true, mode: 0o700 });
const databasePath = join(stateDir, "private.sqlite");
const children = new Map();
const remotePids = new Map();
const shutdown = new AbortController();
const stopped = new Promise((resolveStop) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shutdown.abort();
      resolveStop();
    });
  }
});
let db;
let origin;
let ready = false;

const progress = (message) => console.log(`[p4b-review] ${message}`);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const safeCode = (value) =>
  typeof value === "string" && /^[a-z_]+$/.test(value) ? value : "unknown";

function start(command, args, label, env = process.env) {
  shutdown.signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: repo,
    env,
    detached: true,
    // Auth, Worker identity and remote results must never reach a log file.
    stdio: "ignore",
  });
  const record = {
    child,
    label,
    persistent: label === "server" || /^worker-\d+$/.test(label),
    expected: false,
    exited: false,
    code: null,
  };
  record.done = new Promise((resolveExit) => {
    child.once("error", () => {
      record.exited = true;
      record.code = "spawn_error";
      resolveExit();
    });
    child.once("exit", (code, signal) => {
      record.exited = true;
      record.code = code ?? signal;
      resolveExit();
      if (ready && !record.expected && !shutdown.signal.aborted) {
        progress(`${label} exited; stopping environment`);
        process.exitCode = 1;
        shutdown.abort();
      }
    });
  });
  children.set(label, record);
  return record;
}

async function run(command, args, label, env, timeoutMs = 600_000) {
  const record = start(command, args, label, env);
  let timer;
  try {
    await Promise.race([
      record.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
      new Promise((_, reject) => {
        shutdown.signal.addEventListener("abort", () => reject(new Error("interrupted")), {
          once: true,
        });
      }),
    ]);
    if (record.code !== 0) throw new Error(`${label} failed (${record.code})`);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    for (const { label: childLabel, exited, code, persistent, expected } of children.values()) {
      if (exited && !expected && (persistent || code !== 0))
        throw new Error(`${childLabel} exited (${code}) while ${label}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolveListen, reject) => {
    socket.once("error", reject);
    socket.listen(0, "0.0.0.0", resolveListen);
  });
  const port = socket.address().port;
  await new Promise((resolveClose, reject) =>
    socket.close((error) => (error ? reject(error) : resolveClose())),
  );
  if (port === 3000) throw new Error("Refusing port 3000");
  return port;
}

function serverFunctionIds(directory, result = new Map()) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) serverFunctionIds(path, result);
    else if (/\.(?:m?js)$/.test(entry)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)) {
        result.set(match[2], match[1]);
      }
    }
  }
  return result;
}

/** Read-only projection of the rows the assertions need; nothing here writes. */
function readLeaseRow(machineId) {
  return db
    .prepare(
      "SELECT state, generation, holder_instance_id, changed_at FROM machine_lease WHERE machine_id=?",
    )
    .get(machineId);
}
/** The pending receipt id is derived by the product from the pending receipt, not stored. */
function readPendingMutation(machineId) {
  return db
    .prepare(
      "SELECT id, action, state, expected_generation FROM lease_mutation WHERE machine_id=? AND state='pending'",
    )
    .get(machineId);
}
/** Lease rows are exposed without snake_case column names in the Human document. */
function leaseProjection(row, pending) {
  if (!row) return null;
  return {
    state: row.state,
    generation: row.generation,
    holderInstanceId: row.holder_instance_id,
    pendingMutationId: pending?.id ?? null,
    changedAt: row.changed_at,
  };
}
function readExecutions(machineId) {
  return db
    .prepare(
      "SELECT id, request_id, state, failure_reason, drained_at, terminal_at, authorization_generation, dispatch_connection_generation FROM remote_execution WHERE machine_id=? ORDER BY created_at",
    )
    .all(machineId);
}
function executionFor(machineId, requestId) {
  return readExecutions(machineId).find((row) => row.request_id === requestId);
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function prepare() {
  progress(`Private state: ${stateDir}`);
  if (!existsSync(join(repo, ".output/server/index.mjs"))) {
    progress("Building production service");
    await run("pnpm", ["build"], "build");
  }
  if (!existsSync(join(repo, "dist/worker/main.js"))) {
    progress("Building Worker");
    await run("pnpm", ["worker:build"], "worker-build");
  }
  const port = await freePort();
  let reviewHost = process.env.SPROUT_REVIEW_HOST?.trim();
  if (!reviewHost) {
    const detected = spawnSync("ipconfig", ["getifaddr", "en0"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    reviewHost = detected.status === 0 ? detected.stdout.trim() : "";
    if (!reviewHost) {
      reviewHost = "127.0.0.1";
      console.warn(
        "[p4b-review] LAN host detection failed; using loopback. Set SPROUT_REVIEW_HOST to a hostname reachable from the review device.",
      );
    }
  }
  const reviewAddress = new URL(`http://${reviewHost}`);
  if (
    reviewAddress.username ||
    reviewAddress.password ||
    reviewAddress.port ||
    reviewAddress.pathname !== "/" ||
    reviewAddress.search ||
    reviewAddress.hash
  ) {
    throw new Error("SPROUT_REVIEW_HOST must be a hostname or IP address without a port");
  }
  reviewAddress.port = String(port);
  origin = reviewAddress.origin;
  process.env.NO_PROXY += `,${reviewAddress.hostname}`;
  process.env.no_proxy = process.env.NO_PROXY;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "0.0.0.0",
    NITRO_PORT: String(port),
    NITRO_HOST: "0.0.0.0",
    DATABASE_URL: databasePath,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    SPROUT_PI_ENABLED: "true",
    SPROUT_PI_DATA_DIR: join(stateDir, "pi"),
    SPROUT_REPO_DIR: join(stateDir, "repos"),
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  // Always use the actual product Pi runner, even if the caller runs acceptance fixtures.
  delete env.SPROUT_PI_RUNNER;
  await run("pnpm", ["db:migrate"], "migrate", env);
  start(process.execPath, [".output/server/index.mjs"], "server", env);
  await until(async () => {
    try {
      return (
        await fetch(`${origin}/api/health`, {
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]),
        })
      ).ok;
    } catch {
      return false;
    }
  }, "service health");
  db = new Database(databasePath, { readonly: true });
  const ids = serverFunctionIds(join(repo, ".output/server"));
  const email = `p4b-review3-${randomUUID()}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "P4b Human", email, password }),
    signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]),
  });
  if (!signUp.ok) throw new Error(`Registration failed (HTTP ${signUp.status})`);
  const cookie = signUp.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("Registration returned no session");
  async function call(name, data) {
    const id = ids.get(name);
    if (!id) throw new Error(`Missing built server function: ${name}; rebuild with pnpm build`);
    const response = await fetch(`${origin}/_serverFn/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tsr-serverfn": "true",
        origin,
        cookie,
      },
      body: JSON.stringify(toJSON({ data })),
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error(`${name} failed (HTTP ${response.status})`);
    const raw = await response.json();
    const decoded = raw?.t !== undefined ? fromCrossJSON(raw, { refs: new Map() }) : raw;
    const result = decoded.result ?? decoded;
    if (!result.ok) throw new Error(`${name} failed (${safeCode(result.error?.code)})`);
    return result.data;
  }
  const project = await call("createProjectFn", { name: "P4b Human playground" });
  const model = process.env.SPROUT_REVIEW_MODEL || "magpie/auto/deepseek-v4.1-flash";
  const holderProfile = await call("createAgentProfileFn", {
    name: "P4b review agent",
    persona:
      "You prepare this private Human playground using Sprout remote tools. Follow exact tool instructions. Never print file contents, shell output, secrets or credentials. Report only IDs and states.",
    effort: "off",
    model,
  });
  await call("addProjectMemberFn", { projectId: project.id, agentProfileId: holderProfile.id });
  const holderChatResult = await call("createDirectChatFn", {
    projectId: project.id,
    agentProfileId: holderProfile.id,
  });
  const holderChat = holderChatResult.chat ?? holderChatResult;
  const nextProfile = await call("createAgentProfileFn", {
    name: "P4b second agent",
    persona:
      "You act only through Sprout remote tools, follow exact instructions, never print credentials or output, and report only IDs and states.",
    effort: "off",
    model,
  });
  await call("addProjectMemberFn", { projectId: project.id, agentProfileId: nextProfile.id });
  const nextChatResult = await call("createDirectChatFn", {
    projectId: project.id,
    agentProfileId: nextProfile.id,
  });
  const nextChat = nextChatResult.chat ?? nextChatResult;

  // M1 settled holder for the deep-link/digest checks · M2 the implementer's fencing control ·
  // M3 the fencing scene left untouched for the Human (also carries the survival sleep).
  const machines = [];
  for (let index = 1; index <= 3; index++) {
    const root = join(stateDir, `machine-${index}`, "root");
    const workspace = join(root, project.id);
    const workerStateDir = join(stateDir, `machine-${index}`, "worker");
    mkdirSync(workspace, { recursive: true });
    const enrollment = await call("createMachineFn", { name: `P4b review Machine ${index}` });
    const machine = enrollment.detail.machine;
    await call("saveMachineRootDirectoryFn", {
      machineId: machine.id,
      directory: root,
      expectedRevision: machine.rootRevision,
    });
    await call("saveProjectMachineBindingFn", {
      machineId: machine.id,
      projectId: project.id,
      description: "Human playground",
      expectedRevision: null,
    });
    const ticketFile = join(stateDir, `machine-${index}`, "ticket");
    writeFileSync(ticketFile, enrollment.ticket, { mode: 0o600 });
    await run(
      process.execPath,
      [
        "dist/worker/main.js",
        "init",
        "--server",
        origin,
        "--machine",
        machine.id,
        "--ticket-file",
        ticketFile,
        "--allow-http",
        origin,
        "--state-dir",
        workerStateDir,
      ],
      `worker-${index}-init`,
      env,
      30_000,
    );
    unlinkSync(ticketFile);
    start(
      process.execPath,
      ["dist/worker/main.js", "run", "--state-dir", workerStateDir],
      `worker-${index}`,
      env,
    );
    await until(
      () =>
        db
          .prepare(
            "SELECT 1 FROM machine_connection WHERE machine_id=? AND status='open' AND capability IS NOT NULL",
          )
          .get(machine.id),
      `Machine ${index} connection and capability`,
    );
    await until(
      async () =>
        (
          await call("getMachineFn", { machineId: machine.id, projectId: project.id })
        ).bindings.some((binding) => binding.observation?.fact?.result?.kind === "accessible"),
      `Machine ${index} project directory`,
    );
    machines.push({ index, id: machine.id, name: machine.name, root, workspace, workerStateDir });
    progress(`Machine ${index} (${machine.id}): open, capability reported`);
  }
  // M1 stays a settled held lease for the digest/deep-link checks; it is only inspected
  // through `machines[0]`, so it needs no local binding.
  const [, control, human] = machines;

  const markerPath = join(human.workspace, "p4b-survival.marker");
  const pidPath = join(human.workspace, "p4b-survival.pid");
  // The remote shell becomes a detached, silent sleep that outlives its Worker and its lease.
  const survivalCommand = `touch ${quote(markerPath)}; printf '%s\\n' "$$" > ${quote(pidPath)}; exec /bin/sleep 86400`;
  const verifyCommand = `test -f ${quote(markerPath)} && test -f ${quote(pidPath)} && kill -0 "$(cat ${quote(pidPath)})" && ps -p "$(cat ${quote(pidPath)})" -o pid=,command=`;
  // Named pipes the Worker really blocks on: opening a FIFO for reading waits for a writer.
  const pipes = new Map();
  for (const machine of [control, human]) {
    const path = join(machine.workspace, "p4b-hold.pipe");
    spawnSync("/usr/bin/mkfifo", [path], { stdio: "ignore", timeout: 10_000 });
    if (!existsSync(path)) throw new Error(`Hold pipe for Machine ${machine.index} missing`);
    pipes.set(machine.id, path);
  }

  async function agentRun(chatId) {
    const state = await call("getChatRunStateFn", { chatId });
    const last = state.runs.at(-1);
    if (last && ["failed", "aborted", "interrupted"].includes(last.status)) {
      throw new Error(`Pi run ${last.status} (${safeCode(last.errorCode)})`);
    }
    return last;
  }
  const requestIds = machines.map(() => `req_${randomUUID()}`);
  const survivalRequestId = `req_${randomUUID()}`;
  const pipeRequestIds = [control, human].map(() => `req_${randomUUID()}`);
  await call("sendMessageFn", {
    chatId: holderChat.id,
    body: [
      "Prepare this private Human review environment. Use ONLY Sprout tools; never local bash/read/write.",
      `Step 1: for EACH of these Machine IDs, call sprout_lease_get then sprout_lease_acquire. Use the generation from lease_get as expectedGeneration, and these exact requestIds in this Machine order: ${machines.map((machine) => machine.id).join(", ")} -> ${requestIds.join(", ")}.`,
      `Step 2: call sprout_remote_shell on Machine ${human.id} with authorizationGeneration from its held lease, cwd=${human.workspace}, waitMs=1000, requestId=${survivalRequestId}, and this exact command: ${survivalCommand}. Then poll sprout_remote_execution_get with that executionId until it reports succeeded. Never repeat the shell.`,
      `Step 3: call sprout_remote_file_read on Machine ${control.id} with path=${pipes.get(control.id)}, maxBytes=1, authorizationGeneration from its held lease, requestId=${pipeRequestIds[0]}. That call blocks by design: make it once and do NOT poll or retry it.`,
      `Step 4: call sprout_remote_file_read on Machine ${human.id} with path=${pipes.get(human.id)}, maxBytes=1, authorizationGeneration from its held lease, requestId=${pipeRequestIds[1]}. Same: make it once and do NOT poll or retry it.`,
      "Keep all three leases. Do not release, handoff, force anything, or signal any process. Do not print file contents or command output. Reply only with Machine IDs and lease states.",
    ].join("\n"),
  });
  const leases = await until(
    async () => {
      const held = await Promise.all(
        machines.map(
          async (machine) =>
            (await call("getLeaseFn", { projectId: project.id, machineId: machine.id })).lease,
        ),
      );
      if (!held.every((lease) => lease.state === "held")) {
        const active = await agentRun(holderChat.id);
        if (active?.status === "completed")
          throw new Error("Pi completed without three held leases");
        return false;
      }
      if (new Set(held.map((lease) => lease.holderInstanceId)).size !== 1)
        throw new Error("Machines have different holders");
      return held;
    },
    "one instance holding all three Machine leases",
    300_000,
  );
  const survivalExecution = await until(
    async () => {
      const executions = await call("listProjectExecutionsFn", {
        projectId: project.id,
        machineId: human.id,
        limit: 100,
      });
      const remote = executions.find((item) => item.requestId === survivalRequestId);
      if (!remote || remote.operation.kind !== "shell") return false;
      if (["failed", "rejected", "timed_out", "unknown"].includes(remote.state))
        throw new Error(`Survival shell ${remote.state} (${safeCode(remote.failureReason)})`);
      return remote.state === "succeeded" ? remote : false;
    },
    "survival shell success",
    180_000,
  );
  const survivalPid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(survivalPid) || survivalPid <= 1)
    throw new Error("Survival shell PID file is not a usable pid");
  if (survivalExecution.result?.pid !== survivalPid)
    throw new Error("Survival shell PID does not match its trace");
  process.kill(survivalPid, 0);
  remotePids.set("survival-sleep", survivalPid);
  const survivalCheck = () => {
    const started = Date.now();
    const result = spawnSync("/bin/sh", ["-lc", verifyCommand], {
      stdio: "ignore",
      timeout: 15_000,
    });
    return {
      exitCode: result.status,
      elapsedMs: Date.now() - started,
      pidAlive: isAlive(survivalPid),
      markerPresent: existsSync(markerPath),
      pidFilePresent: existsSync(pidPath),
    };
  };
  // Both blocking reads must be dispatched and un-drained before anything else happens.
  await until(
    () =>
      [control, human].every((machine, index) => {
        const row = executionFor(machine.id, pipeRequestIds[index]);
        return (
          row &&
          row.dispatch_connection_generation !== null &&
          row.drained_at === null &&
          ["dispatched", "running"].includes(row.state)
        );
      }),
    "blocking remote reads dispatched and un-drained",
    120_000,
  );
  const setupRun = await until(
    async () => {
      const active = await agentRun(holderChat.id);
      return active?.status === "completed" ? active : false;
    },
    "Pi setup run completion",
    240_000,
  );
  if (survivalCheck().exitCode !== 0) throw new Error("Survival check failed before fencing");

  // ------------------------------------- real fencing: release, then SIGKILL the Worker
  const releaseIds = [control, human].map(() => `req_${randomUUID()}`);
  await call("sendMessageFn", {
    chatId: holderChat.id,
    body: [
      "Use ONLY Sprout tools. Do not run shell, read files, acquire or touch any other Machine.",
      ...machines
        .slice(1)
        .map(
          (machine, index) =>
            `For Machine ${machine.id}: call sprout_lease_get, then sprout_lease_release with expectedGeneration from that lease_get and requestId=${releaseIds[index]}. Report the receipt state only.`,
        ),
    ].join("\n"),
  });
  const fenced = await until(
    () => {
      const facts = [control, human].map((machine, index) => ({
        machine,
        lease: readLeaseRow(machine.id),
        receiptRequestId: releaseIds[index],
        execution: executionFor(machine.id, pipeRequestIds[index]),
      }));
      if (
        !facts.every(
          (fact) => fact.lease?.state === "fencing" && readPendingMutation(fact.machine.id),
        )
      )
        return false;
      if (!facts.every((fact) => fact.execution?.drained_at === null)) return false;
      return facts;
    },
    "leases parked in fencing by the real release",
    240_000,
  );
  for (const fact of fenced) {
    if (fact.lease.holder_instance_id !== setupRun.instanceId)
      throw new Error("Fencing lost the original holder");
    if (fact.lease.generation !== leases[0].generation)
      throw new Error("Fencing advanced the generation");
    const pending = readPendingMutation(fact.machine.id);
    progress(
      `Fencing Machine ${fact.machine.index}: generation ${fact.lease.generation}, ` +
        `pending ${pending.id}, execution ${fact.execution.state}, drained_at NULL`,
    );
  }
  const killed = [];
  for (const fact of fenced) {
    const record = children.get(`worker-${fact.machine.index}`);
    const workerPid = record?.child.pid;
    if (!workerPid || record.exited)
      throw new Error(`Machine ${fact.machine.index} Worker not running`);
    progress(`SIGKILL Machine ${fact.machine.index} Worker group (pid ${workerPid})`);
    record.expected = true;
    try {
      process.kill(-workerPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await until(() => record.exited, `Machine ${fact.machine.index} Worker death`, 20_000);
    killed.push({ machine: fact.machine, workerPid });
  }
  // Polling the lease runs the product's own expiry, which is what turns the blocked read into
  // `unknown` / `worker_lost` while keeping `drained_at` NULL. Nothing is written by this script.
  const expired = await until(
    async () => {
      const facts = [];
      for (const [index, fact] of fenced.entries()) {
        const viewed = await call("getLeaseFn", {
          projectId: project.id,
          machineId: fact.machine.id,
        });
        if (viewed.lease.state !== "fencing") throw new Error("Lease left fencing");
        const row = executionFor(fact.machine.id, pipeRequestIds[index]);
        if (!row || row.drained_at !== null) return false;
        if (row.state !== "unknown") return false;
        facts.push({ machine: fact.machine, lease: viewed.lease, execution: row });
      }
      return facts;
    },
    "blocked reads expire to unknown with NULL drained_at while the lease stays fencing",
    180_000,
  );
  for (const { machine, workerPid } of killed) {
    if (isAlive(workerPid)) throw new Error(`Machine ${machine.index} Worker survived SIGKILL`);
  }
  for (const fact of expired) {
    // Both reasons are real end-of-certainty: `worker_lost` when the stale connection is seen
    // first, `deadline` when the execution deadline passes first. Either way it is unknown and
    // not drained, which is what keeps the lease in fencing.
    if (!["worker_lost", "deadline"].includes(fact.execution.failure_reason))
      throw new Error(`Uncertain execution reason is ${fact.execution.failure_reason}`);
    if (fact.lease.holderInstanceId !== setupRun.instanceId)
      throw new Error("Holder was replaced by the kill");
    progress(
      `Held-but-dead Machine ${fact.machine.index}: ${fact.execution.state}/${fact.execution.failure_reason}, drained_at NULL, Worker gone`,
    );
  }
  const survivalBeforeForce = survivalCheck();
  if (survivalBeforeForce.exitCode !== 0)
    throw new Error("Fencing terminated the survival process or removed its files");

  const projection = (rows) =>
    rows.map((row) => ({
      executionId: row.id,
      state: row.state,
      failureReason: row.failure_reason,
      drainedAt: row.drained_at,
      terminalAt: row.terminal_at,
      generation: row.authorization_generation,
    }));
  const fencingDoc = expired.map((fact) => ({
    machineId: fact.machine.id,
    machineIndex: fact.machine.index,
    name: fact.machine.name,
    detailUrl: `${origin}/machines/${fact.machine.id}/lease?projectId=${project.id}`,
    lease: {
      state: fact.lease.state,
      generation: fact.lease.generation,
      holderInstanceId: fact.lease.holderInstanceId,
      pendingMutationId: fact.lease.pendingMutationId,
    },
    pendingReceipt: { mutationId: fact.lease.pendingMutationId, state: "pending" },
    workerPid: killed.find((item) => item.machine.id === fact.machine.id)?.workerPid ?? null,
    workerAliveAfterKill: isAlive(
      killed.find((item) => item.machine.id === fact.machine.id)?.workerPid ?? 0,
    ),
    unknownExecution: {
      executionId: fact.execution.id,
      state: fact.execution.state,
      failureReason: fact.execution.failure_reason,
      drainedAt: fact.execution.drained_at,
      generation: fact.execution.authorization_generation,
    },
    executions: projection(readExecutions(fact.machine.id)),
    role:
      fact.machine.id === control.id
        ? "对照组：实现者自验强制收回与截图用，走查后租约会前进"
        : "留给 Human 亲手强制收回的现场，脚本不碰",
  }));
  const humanFencing = fencingDoc.find((entry) => entry.machineId === human.id);
  const probePidDirectory = join(stateDir, "running-probe-pids");
  mkdirSync(probePidDirectory, { mode: 0o700 });
  const infoPath = join(infoDir, `review-info-${port}.json`);
  const runningProbeCommand = `node ${quote(join(repo, "scripts/dev/p4b-running-probe.mjs"))} ${quote(infoPath)}`;
  const info = {
    stateDir,
    origin,
    port,
    login: { url: `${origin}/login`, email, password },
    project: { id: project.id, name: project.name },
    machines: machines.map((machine) => {
      const fencedMachine = fencingDoc.find((entry) => entry.machineId === machine.id);
      return {
        index: machine.index,
        id: machine.id,
        name: machine.name,
        root: machine.root,
        workspace: machine.workspace,
        detailUrl: `${origin}/machines/${machine.id}/lease?projectId=${project.id}`,
        connectionState: fencedMachine ? "closed" : "open",
        lease: fencedMachine
          ? fencedMachine.lease
          : leaseProjection(readLeaseRow(machine.id), readPendingMutation(machine.id)),
        role: fencedMachine ? fencedMachine.role : "正常持有：真实 Worker 在线，租约 held",
      };
    }),
    chat: { id: holderChat.id, url: `${origin}/projects/${project.id}/chats/${holderChat.id}` },
    chats: [
      {
        label: "原持有者 Chat（分身名 P4b review agent）",
        id: holderChat.id,
        url: `${origin}/projects/${project.id}/chats/${holderChat.id}`,
      },
      {
        label: "新持有者 Chat（分身名 P4b second agent）",
        id: nextChat.id,
        url: `${origin}/projects/${project.id}/chats/${nextChat.id}`,
      },
    ],
    settingsUrl: `${origin}/projects/${project.id}/settings`,
    holderInstanceId: setupRun.instanceId,
    holderChatId: holderChat.id,
    setupRun: { id: setupRun.id, status: setupRun.status },
    remoteExecution: {
      id: survivalExecution.executionId,
      machineId: survivalExecution.machineId,
      runId: survivalExecution.runId,
      state: survivalExecution.state,
    },
    survival: {
      markerPath,
      pidPath,
      pid: survivalPid,
      machineId: human.id,
      commandFragment: "/bin/sleep 86400",
      verifyCommand,
    },
    fencing: {
      how: [
        "1) 持有者在该 Machine 上发起真实的远端 file_read，目标是一根命名管道（FIFO）；Worker 真的阻塞在 open(2) 上，所以该执行已投递、未终态、没有排空。",
        "2) 同一个持有者用页面同一条路径发起 release；因为存在未排空的已投递执行，收据停在 pending、租约进入 fencing，只有 Worker 的 fence 确认能推进它。",
        "3) 用 SIGKILL 杀掉该 Machine 的真实 Worker 进程组，fence 确认永远不会到达；过了心跳超时，服务端自己的过期逻辑把该执行标成 unknown / worker_lost，drained_at 保持 NULL。",
      ].join(" "),
      whyReal:
        "SIGKILL 是真实的进程终止；阻塞来自真实 open(2)；执行终态、未知原因与 drained_at 全部由服务端自己的过期逻辑产生。本脚本没有写任何租约、收据或执行记录，没有伪造 drain。",
      machines: fencingDoc,
    },
    forceReclaim: {
      executedThrough:
        "真实 Human server function forceReclaimLeaseFn（登录会话 cookie + confirm:true）；页面按钮走同一条边界",
      inputShape: {
        action: "force_reclaim",
        machineId: "<fencing Machine id>",
        expectedGeneration: "<fencing.machines[].lease.generation>",
        mutationId: "<fencing.machines[].lease.pendingMutationId>",
        confirm: true,
      },
      note: "脚本本身不执行强制收回：M3 留给 Human 在页面完成，M2 由实现者在 Chromium 中完成并在报告中留证。",
    },
    survivalBeforeForce,
    newHolder: {
      profileId: nextProfile.id,
      chatId: nextChat.id,
      chatUrl: `${origin}/projects/${project.id}/chats/${nextChat.id}`,
      note: "强制收回后租约变 free、代次 +1；在 Machine 详情“执行租约请求的 Chat”里选 P4b second agent 的 Chat，再点“申请租约”，新 holder 才出现（走真实 Pi run，可能要几十秒）。",
    },
    runningProbe: {
      machineId: machines[0].id,
      chatId: holderChat.id,
      leaseUrl: `${origin}/machines/${machines[0].id}/lease?projectId=${project.id}`,
      machineSettingsUrl: `${origin}/machines/${machines[0].id}`,
      cwd: machines[0].workspace,
      pidDirectory: probePidDirectory,
      command: runningProbeCommand,
      observationWindow:
        "Inspect immediately after running confirmed. The execution has a 10-second maximum observation window and only a few seconds may remain when the Worker reports running. Auto-refresh is every 5 seconds; reload if needed. Repeat only when the original holder Chat is idle. The shell sleeps 20 seconds; waitMs=10000 is the execution observation window, not process termination.",
      lastObservation: null,
    },
    processes: [...children.values()]
      .filter((record) => !record.exited)
      .map(({ label, child }) => ({ label, pid: child.pid })),
    instructions: [
      "安全边界：这是临时私有体验环境，能以运行用户的权限执行真实远程 shell、文件与进程操作，工作目录不是安全边界。应用监听 0.0.0.0，同一内网可达；仅在评审期间保持运行，结束后向本脚本发送 SIGTERM 清理。不要在人多或不可信网络上开启。登录仍须使用本次真实账号密码；凭据只保存在权限为 0600 的 review-info.json，不要公开分享。",
      "先读：Machine 1 的 Worker 在线、租约 held。Machine 2 与 3 的 Worker 已被 SIGKILL，两份租约停在 fencing 等 Human 处理。M2 是实现者自验的对照组（可能已被推进），M3 是留给你亲手的现场。租约在 /machines/<id>/lease?projectId=…；该页只有租约与远端操作，不应出现‘连接与配对’‘Shell 能力’‘工作目录’‘Project 绑定’‘安装与维护’区块，也不应有‘设置’分组标题。",
      `1) 登录：打开 login.url，用 login.email / login.password。端口是 ${port}，不是 3000。另打开 runningProbe.machineSettingsUrl，即 /machines/<id>（不带 projectId），应该看到全部五个设置区块。两个方向都亲眼核对。`,
      "2) 租约事实：打开 machines[0].detailUrl（Machine 1）。核对租约状态、代次、持有者名称与 instance、“申请与释放”表单下的收据，并确认说明写着租约单位是 Project × Machine、变更不会终止进程或删除文件。",
      "3) fencing 摘要 + 问号 Dialog：打开 machines[2].detailUrl（Machine 3）。租约行显示“等待 Worker 确认”，正文只有一句摘要；点右侧问号打开 Dialog，应能看到等待时长、待处理动作与代次、收据 id、执行总数与未知（unknown / worker_lost）执行条数与 executionId。该 Machine 的设置页连接区块显示断开，这是 Worker 被 SIGKILL 的真实后果；租约页不显示该设置区块。",
      `4) 强制收回五步（gate B）：仍在该 Dialog —— (a) 风险确认复选框默认未勾选；(b) 未勾选时“强制收回”按钮不可点；(c) 勾选后点“强制收回”；(d) 出现收据（mutationId + completed，文案标明“未确认 Worker 排空”）；(e) 关闭 Dialog 等 5 秒自动刷新，租约变“空闲”、代次 ${(humanFencing?.lease.generation ?? 0) + 1}，强制收回入口消失。`,
      `5) 新 holder 取得租约：同一页面上方“执行租约请求的 Chat”里选择 P4b second agent 的 Chat（即 chats[1]），再点“申请租约”；收到服务端收据后租约变“持有中”、持有者是 P4b second agent、代次 ${(humanFencing?.lease.generation ?? 0) + 2}。这会启动一次真实 Pi run，可能要几十秒。`,
      `6) 进程与文件仍在：强制收回前后各跑一次 survival.verifyCommand（原样复制），两次都应 exit 0。它检查 pid ${survivalPid}（/bin/sleep 86400）、marker 与 pid 文件——这台 Machine 的 Worker 已被杀、租约已被强制收回，进程与文件仍在，说明租约动作不终止进程、不删除文件。`,
      "7) Project settings 只剩摘要 + 深链（A 方案）：打开 settingsUrl 的租约区块，不应有申请/释放表单，只有摘要与到 Machine 租约页的链接；点深链应跳到 /machines/<id>/lease?projectId=…，只见租约与远端操作。",
      "8) 真实 running 色：先打开 runningProbe.leaseUrl，再在终端执行 runningProbe.command。经真实 Chat → sprout_remote_shell → macOS Worker 执行 20 秒 shell（waitMs=10000）。看到 running confirmed 后立即观察/刷新（运行窗口上限 10 秒，确认时可能只剩数秒；自动刷新 5 秒），远端操作中‘运行中’标签应为警告色而非成功绿，旁边写着‘未到终态：不显示成功’。runningProbe.lastObservation 记录执行 id、当时 state=running、时间及真实 PID 检查；错过窗口后等 Chat 空闲再重跑。卡片只展示类型、状态与不确定性，不显示命令正文、路径、stdout/stderr，页面搜不到 /bin/sleep。",
      "9) Chat 标题：打开 chats[0].url 改标题（列表与 header 跟着变），再恢复默认（回落到分身名 P4b review agent；分身名缺失时回落 Agent）。列表与 header 不应出现裸 chat id。",
      "10) 主题与宽度：浅色/暗色各一遍，并在 390px / 900px / 1200px / 1440px 下确认以上内容可读、无横向溢出。",
      "11) 结束：Ctrl-C 或 SIGTERM 结束脚本。服务、三台 Worker、远端 sleep 与私有状态目录都会被回收，review-info.json 保留。重复运行会得到全新端口、账号与目录。",
      "已知限制：跨机网络未验证（三台 Worker 都在本机）；真机软键盘未验证。",
    ],
  };
  writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await until(
    async () => (await agentRun(holderChat.id))?.status === "completed",
    "release run completion",
    240_000,
  );
  await run(
    process.execPath,
    ["scripts/dev/p4b-running-probe.mjs", infoPath],
    "running-probe",
    env,
    240_000,
  );
  const document = readFileSync(infoPath, "utf8");
  writeFileSync(join(infoDir, "review-info.json"), document, { mode: 0o600 });
  ready = true;
  progress(`Ready on ${origin} (port ${port}); instructions: ${infoPath}`);
  await Promise.race([
    stopped,
    new Promise((resolveAbort) =>
      shutdown.signal.addEventListener("abort", resolveAbort, { once: true }),
    ),
  ]);
}

function signalGroup(record, signal) {
  if (!record.child.pid) return;
  try {
    process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** Idempotent: safe to run twice, and leaves no service, Worker or remote process behind. */
async function cleanup() {
  shutdown.abort();
  const probePidDirectory = join(stateDir, "running-probe-pids");
  if (existsSync(probePidDirectory)) {
    for (const file of readdirSync(probePidDirectory)) {
      const pid = Number(readFileSync(join(probePidDirectory, file), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      const command = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2_000,
      });
      if (command.status === 0 && command.stdout.trim() === "/bin/sleep 20")
        remotePids.set(file, pid);
    }
  }
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  const active = [...children.values()].filter((record) => !record.exited);
  for (const record of active) signalGroup(record, "SIGTERM");
  let timer;
  await Promise.race([
    Promise.all(active.map((record) => record.done)),
    new Promise((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, 5000);
    }),
  ]);
  clearTimeout(timer);
  for (const record of active) signalGroup(record, "SIGKILL");
  await Promise.all(active.map((record) => record.done));
  // Detached remote processes are ours: this run's Workers started them.
  for (const pid of remotePids.values()) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  const leftovers = [];
  for (const pid of remotePids.values()) {
    // Reaping is asynchronous: SIGKILL'd children of a dead Worker can linger as zombies for
    // a moment, so confirm twice before reporting an actual survivor.
    if (isAlive(pid)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      if (isAlive(pid)) leftovers.push(pid);
    }
  }
  // Private SQLite, Pi data, Worker state, tickets, workspaces and the FIFOs never outlive the run.
  rmSync(stateDir, { recursive: true, force: true });
  progress(
    leftovers.length === 0
      ? "Stopped service, Workers and remote process; private state removed."
      : `Stopped service and Workers; remote pids still alive: ${leftovers.join(", ")}`,
  );
}

try {
  await prepare();
} catch (error) {
  if (!shutdown.signal.aborted) {
    // All errors generated here contain metadata only; never echo HTTP bodies or child output.
    const message =
      error instanceof Error && error.message.startsWith("fetch")
        ? "HTTP transport failed"
        : error instanceof Error
          ? error.message
          : "Setup failed";
    console.error(`[p4b-review] ${message}; private state: ${stateDir}`);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
