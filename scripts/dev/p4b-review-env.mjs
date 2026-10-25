#!/usr/bin/env node
/** A persistent, private P4b playground. Run directly; stdout contains login credentials. */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "sprout-p4b-review-")));
const databasePath = join(stateDir, "private.sqlite");
const children = new Map();
const shutdown = new AbortController();
const stopped = new Promise((resolveStop) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
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
      if (ready && !shutdown.signal.aborted) {
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
    for (const { label: childLabel, exited, code, persistent } of children.values()) {
      if (exited && (persistent || code !== 0))
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
    socket.listen(0, "127.0.0.1", resolveListen);
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
  origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    NITRO_PORT: String(port),
    NITRO_HOST: "127.0.0.1",
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
  const email = `p4b-review-${randomUUID()}@example.test`;
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
  const profile = await call("createAgentProfileFn", {
    name: "P4b review agent",
    persona:
      "You prepare this private Human playground using Sprout remote tools. Follow exact tool instructions. Never print file contents, shell output, secrets or credentials. Report only IDs and states.",
    effort: "off",
    model: process.env.SPROUT_REVIEW_MODEL || "magpie/auto/deepseek-v4.1-flash",
  });
  await call("addProjectMemberFn", { projectId: project.id, agentProfileId: profile.id });
  const chatResult = await call("createDirectChatFn", {
    projectId: project.id,
    agentProfileId: profile.id,
  });
  const chat = chatResult.chat ?? chatResult;
  const machines = [];
  for (let index = 1; index <= 2; index++) {
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
    machines.push({ id: machine.id, name: machine.name, root, workspace, workerStateDir });
    progress(`Machine ${machine.id}: open, capability reported`);
  }
  const markerPath = join(machines[0].workspace, "p4b-survival.marker");
  const pidPath = join(machines[0].workspace, "p4b-survival.pid");
  // The remote shell itself becomes a detached, silent sleep. No output is returned.
  const command = `touch ${quote(markerPath)}; printf '%s\\n' "$$" > ${quote(pidPath)}; exec /bin/sleep 86400`;
  async function agentRun() {
    const state = await call("getChatRunStateFn", { chatId: chat.id });
    const last = state.runs.at(-1);
    if (last && ["failed", "aborted", "interrupted"].includes(last.status)) {
      throw new Error(`Pi setup run ${last.status} (${safeCode(last.errorCode)})`);
    }
    return last;
  }
  const requestIds = machines.map(() => `req_${randomUUID()}`);
  const shellRequestId = `req_${randomUUID()}`;
  await call("sendMessageFn", {
    chatId: chat.id,
    body: `Prepare this Human review environment now. Use ONLY Sprout tools (never local bash/read/write). First sprout_lease_get then sprout_lease_acquire for EACH of these explicit Machine IDs: ${machines.map((machine) => machine.id).join(", ")}. Use the generation returned by lease_get as expectedGeneration and a unique requestId for each mutation. Use these exact acquisition requestIds in Machine order: ${requestIds.join(", ")}. Hold BOTH leases as this same instance. Once held, call sprout_remote_shell on Machine ${machines[0].id}, authorizationGeneration from its held lease, cwd=${machines[0].workspace}, waitMs=1000, requestId=${shellRequestId}, and command exactly: ${command}. If shell returns queued/dispatched/running, poll sprout_remote_execution_get using that executionId; never repeat the shell. Keep both leases; do not release or handoff, do not signal any process. Do not read any file or print output. Reply only with Machine IDs and lease states.`,
  });
  let leases = await until(
    async () => {
      const values = await Promise.all(
        machines.map((machine) =>
          call("getLeaseFn", { projectId: project.id, machineId: machine.id }),
        ),
      );
      const held = values.map((value) => value.lease);
      if (!held.every((lease) => lease.state === "held")) {
        const run = await agentRun();
        if (run?.status === "completed") throw new Error("Pi completed without both held leases");
        return false;
      }
      if (held[0].holderInstanceId !== held[1].holderInstanceId)
        throw new Error("Machines have different holders");
      return held;
    },
    "same project instance holding both Machine leases",
    300_000,
  );
  await until(
    async () => {
      if (existsSync(pidPath) && existsSync(markerPath)) return true;
      const run = await agentRun();
      if (run?.status === "completed") throw new Error("Pi completed without survival traces");
      return false;
    },
    "remote shell survival traces",
    180_000,
  );
  const completedRun = await until(
    async () => {
      const run = await agentRun();
      return run?.status === "completed" ? run : false;
    },
    "Pi setup run completion",
    180_000,
  );
  leases = await Promise.all(
    machines.map(
      async (machine) =>
        (await call("getLeaseFn", { projectId: project.id, machineId: machine.id })).lease,
    ),
  );
  if (
    !leases.every(
      (lease) => lease.state === "held" && lease.holderInstanceId === completedRun.instanceId,
    )
  ) {
    throw new Error("Setup run did not preserve both held leases");
  }
  const execution = await until(async () => {
    const executions = await call("listProjectExecutionsFn", {
      projectId: project.id,
      machineId: machines[0].id,
      limit: 100,
    });
    const remote = executions.find((item) => item.requestId === shellRequestId);
    if (
      !remote ||
      remote.runId !== completedRun.id ||
      remote.operation.kind !== "shell" ||
      remote.operation.command !== command
    ) {
      throw new Error("Setup run did not submit the requested remote shell");
    }
    if (["failed", "rejected", "timed_out", "unknown"].includes(remote.state)) {
      throw new Error(`Remote setup shell ${remote.state} (${safeCode(remote.failureReason)})`);
    }
    return remote.state === "succeeded" ? remote : false;
  }, "remote shell completion");
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1 || execution.result?.pid !== pid) {
    throw new Error("Remote shell PID does not match its survival trace");
  }
  process.kill(pid, 0);
  const verifyCommand = `test -f ${quote(markerPath)} && test -f ${quote(pidPath)} && kill -0 "$(cat ${quote(pidPath)})" && ps -p "$(cat ${quote(pidPath)})" -o pid=,command=`;
  const info = {
    stateDir,
    origin,
    login: { url: `${origin}/login`, email, password },
    project: { id: project.id, name: project.name },
    machines: machines.map((machine, index) => ({
      ...machine,
      connectionState: "open",
      lease: leases[index],
      detailUrl: `${origin}/machines/${machine.id}?projectId=${project.id}`,
    })),
    chat: { id: chat.id, url: `${origin}/projects/${project.id}/chats/${chat.id}` },
    settingsUrl: `${origin}/projects/${project.id}/settings`,
    holderInstanceId: leases[0].holderInstanceId,
    setupRun: { id: completedRun.id, status: completedRun.status },
    remoteExecution: {
      id: execution.executionId,
      machineId: execution.machineId,
      runId: execution.runId,
      state: execution.state,
    },
    survival: { markerPath, pidPath, pid, commandFragment: "/bin/sleep 86400", verifyCommand },
    processes: [...children.values()]
      .filter((record) => !record.exited)
      .map(({ label, child }) => ({ label, pid: child.pid })),
    instructions: [
      "Open login.url and sign in with the email/password below. Both Machines use real Workers on this macOS host; cross-machine networking is not simulated.",
      "Open either Machine detail URL to inspect the held lease and holder.",
      "Chat needs a chat to show the inspector; the chat above is already created. Open its URL, then open Info Hub to inspect both held Machines.",
      "Run survival.verifyCommand before and after lease release, handoff or reclaim. Those lease actions should leave the process and file in place.",
      "Keep this command running during review. Ctrl-C/SIGTERM closes this service and both Workers and releases the port; it does not signal the detached remote sleep or remove its files.",
      `The remote sleep ends after 24 hours. To remove it manually after review: kill ${pid}. Private state remains at stateDir for inspection; delete it yourself after review.`,
      "This is a local macOS/Chromium playground. Cross-machine networking and a physical mobile keyboard have not been verified.",
    ],
  };
  const infoPath = join(stateDir, "review-info.json");
  writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  ready = true;
  progress(
    `Ready. Local-only login credentials follow; do not redirect stdout to a log. Instructions: ${infoPath}`,
  );
  console.log(JSON.stringify(info, null, 2));
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

async function cleanup() {
  shutdown.abort();
  db?.close();
  const active = [...children.values()].filter((record) => !record.exited || record.persistent);
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
  progress("Stopped service and Workers; private files and detached remote process preserved.");
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
