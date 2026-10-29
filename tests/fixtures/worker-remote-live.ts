import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteCommand, RemoteToolGrant } from "../../src/contracts/remote";
import type { LeaseMutationView, LeaseView } from "../../src/contracts/lease";
import type { AppResult } from "../../src/contracts/result";

assert.equal(process.platform, "darwin", "real macOS Worker required");

assert(
  existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"),
  "run scripts/verify/w-worker-remote.sh to prepare current app and Worker artifacts",
);
mkdirSync(".verify", { recursive: true });
const directory = mkdtempSync(resolve(".verify/w-worker-remote-"));
const children: ReturnType<typeof spawn>[] = [],
  logs: string[] = [],
  checks: string[] = [];
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timeout: ${message}`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.notEqual(port, 3000);
  return port;
}
const port = await freePort(),
  proxyPort = await freePort();
const base = `http://127.0.0.1:${port}`,
  proxyBase = `http://127.0.0.1:${proxyPort}`;
const env = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "false",
  SPROUT_PI_DATA_DIR: join(directory, "private-pi"),
};
function launch(args: string[], name: string, ipc = false) {
  const log = join(directory, name);
  logs.push(log);
  const fd = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  return child;
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned process stop",
    10000,
  );
}
function pass(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
let holdNext = false,
  replayNext = false;
let held:
  | { data: { remote: { commands: RemoteCommand[] }; seq: number }; [key: string]: unknown }
  | undefined;
// Changes only delivery timing. Original bodies remain private, in memory only.
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const upstream = await fetch(base + req.url!, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.json();
    if (req.url === "/api/worker/exchange" && body.ok && body.data.mode === "normal") {
      if (replayNext && held) {
        replayNext = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...held, requestId: body.requestId }));
        return;
      }
      if (holdNext && body.data.remote.commands.length > 0) {
        held = structuredClone(body);
        body.data.remote.commands = [];
        holdNext = false;
      }
    }
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {
    res.writeHead(502);
    res.end();
  }
});
await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof spawn> | undefined;
async function control(
  action: "issue" | "revoke" | "cleanup",
  runId?: string,
): Promise<RemoteToolGrant | undefined> {
  assert(server?.connected);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server!.off("message", receive);
      reject(new Error("grant control timeout"));
    }, 10000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timeout);
      server!.off("message", receive);
      if (message.ok) resolve(message.grant);
      else reject(new Error("private grant control failed"));
    };
    server!.on("message", receive);
    server!.send({ id, action, runId });
  });
}
try {
  server = launch(
    ["--import", "tsx", "tests/fixtures/worker-remote-service.ts"],
    "service.log",
    true,
  );
  await until(async () => {
    try {
      return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "production health");
  browser = await chromium.launch();
  const context = await browser.newContext();
  const signup = await context.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      email: `remote-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Remote verifier",
    },
  });
  assert.equal(signup.status(), 200, "new account signup");
  const account = await signup.json();
  const page = await context.newPage();
  await page.goto(base);
  assert.equal(page.url().startsWith(base), true);
  pass("real production service, Chromium, isolated SQLite and new account");
  Object.assign(process.env, {
    DATABASE_URL: env.DATABASE_URL,
    APP_ORIGIN: base,
    SPROUT_PI_ENABLED: "false",
  });
  const { sqlite } = await import("../../src/db");
  const { createMachine, saveProjectMachineBinding } = await import("../../src/domain/machine");
  const { seedRemoteActor } = await import("./remote-actors");
  const { detachMachine, rejoinProjectMachine } = await import("../../src/server/membership");
  const { getExecution } = await import("../../src/server/remote");
  const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const projectId = newId(ID_PREFIXES.project),
    projectB = newId(ID_PREFIXES.project);
  for (const project of [projectId, projectB])
    sqlite
      .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Worker remote acceptance',?)")
      .run(project, account.user.id);
  const actor = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const actorB = seedRemoteActor(sqlite, account.user.id, projectB, bootId, false);
  const nonHolder = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const otherContext = await browser.newContext();
  const otherSignup = await otherContext.request.post(base + "/api/auth/sign-up/email", {
    headers: { origin: base },
    data: {
      email: `other-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Other remote verifier",
    },
  });
  assert.equal(otherSignup.status(), 200);
  const otherAccount = await otherSignup.json(),
    otherProject = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Other owner',?)")
    .run(otherProject, otherAccount.user.id);
  const otherActor = seedRemoteActor(sqlite, otherAccount.user.id, otherProject, bootId, false);
  const now = () => ({ ...actor, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "Live macOS remote" }, now());
  const machineId = machine.detail.machine.id,
    key = { projectId, machineId };
  saveProjectMachineBinding({ ...key, description: "acceptance", expectedRevision: null }, now());
  saveProjectMachineBinding(
    { projectId: projectB, machineId, description: "independent lease", expectedRevision: null },
    now(),
  );
  const machineB = createMachine({ name: "Project B only" }, now()).detail.machine.id;
  saveProjectMachineBinding(
    { projectId: projectB, machineId: machineB, description: "B only", expectedRevision: null },
    now(),
  );
  sqlite
    .prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?")
    .run(actor.runId);
  const grant = (await control("issue", actor.runId))!;
  const grantB = (await control("issue", actorB.runId))!;
  const nonHolderGrant = (await control("issue", nonHolder.runId))!;
  const otherGrant = (await control("issue", otherActor.runId))!;
  const req = () => newId(ID_PREFIXES.request);
  async function call<T>(
    type: string,
    input: unknown,
    credential: RemoteToolGrant | null = grant,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(base + "/api/remote/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential.secret}` } : {}),
        ...extra,
      },
      body: JSON.stringify({ version: 2, call: { type, input } }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, result: (await response.json()) as AppResult<T> };
  }
  async function good<T>(type: string, input: unknown, credential = grant): Promise<T> {
    const { status, result } = await call<T>(type, input, credential);
    assert.equal(status, 200);
    if (!result.ok) throw new Error(`HTTP operation rejected: ${result.error.code}`);
    return result.data;
  }
  async function rejected(
    type: string,
    input: unknown,
    code: string,
    credential: RemoteToolGrant | null = grant,
    status = 200,
    headers = {},
  ) {
    const response = await call(type, input, credential, headers);
    assert.equal(response.status, status);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.error?.code, code);
  }
  await rejected("lease_get", key, "remote_run_inactive", grant, 401);
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), actor.runId);
  await rejected("lease_get", key, "remote_grant_invalid", null, 401);
  await rejected("lease_get", key, "forbidden", grant, 403, { origin: base });
  await rejected("lease_get", { projectId: projectB, machineId }, "not_found");
  pass(
    "Agent HTTP requires live running grant, rejects cookie-less missing credentials and every Origin",
  );
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const state = join(directory, "private-state");
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      proxyBase,
      "--machine",
      machineId,
      "--state-dir",
      state,
      "--ticket-file",
      ticket,
    ],
    "init.log",
  );
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  let worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
  await until(
    () =>
      ((
        sqlite
          .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
          .get(machineId) as { seq: number } | undefined
      )?.seq ?? 0) >= 1,
    "Worker heartbeat",
  );
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    requestId: req(),
    expectedGeneration: 0,
  });
  await good(
    "lease_mutate",
    { projectId: projectB, machineId, action: "acquire", requestId: req(), expectedGeneration: 0 },
    grantB,
  );
  const counter = join(directory, "counter");
  const input = {
    ...key,
    requestId: req(),
    authorizationGeneration: 1,
    operation: {
      kind: "shell" as const,
      command: `printf x >> '${counter}'; ${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.alloc(65536,255));process.stderr.write(Buffer.alloc(8192,255))'`,
      cwd: directory,
      waitMs: 1000,
    },
  };
  const submit = (input: unknown) => good<ExecutionView>("execution_submit", input);
  await rejected(
    "execution_submit",
    { ...input, requestId: req() },
    "lease_not_holder",
    nonHolderGrant,
  );
  await rejected(
    "execution_submit",
    { ...input, projectId: otherProject, requestId: req() },
    "not_found",
    otherGrant,
  );
  const get = (id: string) => good<ExecutionView>("execution_get", { ...key, executionId: id });
  const lease = () => good<{ lease: LeaseView }>("lease_get", key);
  const execution = await submit(input);
  await until(
    async () => (await get(execution.executionId)).state === "succeeded",
    "real shell result",
  );
  const result = (await get(execution.executionId)).result;
  assert(result?.kind === "shell" && "truncated" in result && result.truncated);
  assert(Buffer.byteLength(result.stdout) <= 65536);
  assert(Buffer.byteLength(result.stderr) <= 8192);
  assert.equal(worker.exitCode, null);
  facts.reportBudget = {
    stdoutUtf8Bytes: Buffer.byteLength(result.stdout),
    stderrUtf8Bytes: Buffer.byteLength(result.stderr),
    truncated: result.truncated,
    workerAlive: worker.exitCode === null,
  };
  assert.equal(statSync(counter).size, 1);
  assert.equal((await submit(input)).executionId, execution.executionId);
  await stop(worker);
  worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker-reconnect.log");
  await until(
    () =>
      (
        sqlite
          .prepare(
            "SELECT generation FROM machine_connection WHERE machine_id=? ORDER BY generation DESC",
          )
          .get(machineId) as { generation: number }
      ).generation >= 2,
    "Worker reconnect",
  );
  await sleep(5500);
  assert.equal(statSync(counter).size, 1);
  facts.execution = {
    counterBytes: 1,
    duplicateAndReconnectCounterBytes: 1,
    outputTruncated: true,
  };
  pass(
    "real Agent HTTP shell execution, requestId replay and reconnect do not repeat, output truncation is marked",
  );
  const crossSentinel = join(directory, "cross-project-absent");
  const crossOperation = {
    kind: "file_write",
    path: crossSentinel,
    content: "fixture",
    mode: "overwrite",
  };
  await rejected(
    "execution_submit",
    { ...input, requestId: req(), projectId: projectB, operation: crossOperation },
    "not_found",
  );
  await rejected(
    "execution_submit",
    { ...input, requestId: req(), machineId: machineB, operation: crossOperation },
    "not_found",
  );
  await rejected(
    "execution_submit",
    { ...input, requestId: req(), machineId: undefined, operation: crossOperation },
    "validation_failed",
  );
  assert(!existsSync(crossSentinel));
  facts.N7_N12 = {
    crossProjectSentinelExists: false,
    missingMachineRejected: true,
    samePhysicalMachineProjectBGeneration: (
      await good<{ lease: LeaseView }>("lease_get", { projectId: projectB, machineId }, grantB)
    ).lease.generation,
  };
  pass(
    "N7/N12 real Agent HTTP rejects cross Project, B-only Machine and missing Machine; private target absent",
  );
  const pidPath = join(directory, "live-pid");
  const running = await submit({
    ...input,
    requestId: req(),
    operation: {
      kind: "shell",
      command: `echo $$ > '${pidPath}'; sleep 15`,
      cwd: directory,
      waitMs: 10000,
    },
  });
  await until(() => existsSync(pidPath), "in-flight shell spawned");
  const pid = Number(readFileSync(pidPath, "utf8"));
  const release = await good<LeaseMutationView>("lease_mutate", {
    ...key,
    action: "release",
    expectedGeneration: 1,
    requestId: req(),
  });
  assert.equal(release.state, "pending");
  assert.equal((await lease()).lease.generation, 1);
  await rejected("execution_submit", { ...input, requestId: req() }, "lease_fencing");
  await until(async () => (await lease()).lease.generation === 2, "real fence/ack generation bump");
  // 代次已前进到 2、租约不再由旧 holder 持有时，真实 HTTP 读取执行与日志都被拒；状态从库事实核。
  await rejected("execution_get", { ...key, executionId: running.executionId }, "lease_not_holder");
  await rejected(
    "execution_log_read",
    { ...key, executionId: running.executionId, cursor: null, limitBytes: 65536 },
    "lease_not_holder",
  );
  const inFlightState = (
    sqlite.prepare("SELECT state FROM remote_execution WHERE id = ?").get(running.executionId) as {
      state: string;
    }
  ).state;
  assert.notEqual(inFlightState, "succeeded");
  process.kill(pid, 0);
  await rejected("execution_submit", { ...input, requestId: req() }, "lease_stale_generation");
  assert(existsSync(counter));
  facts.N6 = {
    acceptedState: release.state,
    acceptedGeneration: 1,
    completedGeneration: 2,
    inFlightState,
    processAliveAfterBump: true,
    filePreserved: true,
  };
  pass(
    "N6 HTTP release stays pending until real fence drain; old requests reject, in-flight cannot succeed, OS process survives",
  );
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    expectedGeneration: 2,
    requestId: req(),
  });
  const stalePath = join(directory, "stale-absent");
  holdNext = true;
  const heldExecution = await submit({
    ...input,
    requestId: req(),
    authorizationGeneration: 3,
    operation: { kind: "file_write", path: stalePath, content: "fixture", mode: "overwrite" },
  });
  await until(() => !!held, "delay real delivery frame");
  assert.equal((await get(heldExecution.executionId)).state, "dispatched");
  const pending = await good<LeaseMutationView>("lease_mutate", {
    ...key,
    action: "release",
    expectedGeneration: 3,
    requestId: req(),
  });
  assert.equal(pending.state, "pending");
  await until(async () => (await lease()).lease.generation === 4, "pending operation fence drain");
  assert(!existsSync(stalePath));
  replayNext = true;
  await until(
    () => worker.exitCode !== null || worker.signalCode !== null,
    "old frame rejected by same real Worker dispatcher",
  );
  assert(!existsSync(stalePath));
  await rejected(
    "execution_submit",
    { ...input, requestId: req(), authorizationGeneration: 3 },
    "lease_stale_generation",
  );
  facts.N5 = {
    delayedGenuineFrame: true,
    staleFrameSeq: held!.data.seq,
    generationBeforeFence: 3,
    generationAfterFence: 4,
    targetExistsBeforeReplay: false,
    targetExistsAfterReplay: false,
    oldHTTPGenerationRejected: true,
  };
  pass(
    "N5/N6 HTTP old generation rejected, pending delivery fenced before spawn, delayed genuine frame rejected, target absent",
  );
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    expectedGeneration: 4,
    requestId: req(),
  });
  const handed = await good<LeaseMutationView>("lease_mutate", {
    ...key,
    action: "handoff",
    expectedGeneration: 5,
    targetInstanceId: nonHolder.instanceId,
    requestId: req(),
  });
  assert.equal(handed.state, "completed");
  assert.equal(handed.completedGeneration, 6);
  const inherited = await good<ExecutionView>(
    "execution_get",
    { ...key, executionId: execution.executionId },
    nonHolderGrant,
  );
  assert.equal(inherited.executionId, execution.executionId);
  assert.equal(inherited.holderInstanceId, actor.instanceId);
  assert.equal(inherited.runId, actor.runId);
  assert.equal(inherited.authorizationGeneration, 1);
  assert.equal(inherited.authority, "inherited");
  assert.equal(inherited.currentAuthorizationGeneration, 6);
  assert.equal(inherited.state, "succeeded");
  await good(
    "execution_log_read",
    { ...key, executionId: execution.executionId, cursor: null, limitBytes: 65536 },
    nonHolderGrant,
  );
  const discovered = await good<{ executions: ExecutionView[]; nextCursor: string | null }>(
    "execution_list",
    { ...key, limit: 100 },
    nonHolderGrant,
  );
  assert(
    discovered.executions.some(
      (view) => view.executionId === execution.executionId && view.authority === "inherited",
    ),
  );
  await rejected(
    "execution_get",
    { ...key, executionId: execution.executionId },
    "lease_not_holder",
  );
  await rejected(
    "execution_log_read",
    { ...key, executionId: execution.executionId, cursor: null, limitBytes: 65536 },
    "lease_not_holder",
  );
  await rejected("execution_list", { ...key, limit: 20 }, "lease_not_holder");
  await rejected(
    "execution_cancel",
    { ...key, executionId: execution.executionId, authorizationGeneration: 6, requestId: req() },
    "lease_not_holder",
  );
  await rejected("execution_submit", input, "lease_stale_generation");
  await rejected(
    "execution_submit",
    { ...input, requestId: req(), authorizationGeneration: 6 },
    "lease_not_holder",
  );
  const human = { userId: actor.userId, bootId, now: new Date(), requestId: req() };
  const removed = detachMachine(
    {
      ...key,
      requestId: req(),
      expectedEpoch: 1,
      expectedRevision: 1,
      expectedGeneration: 6,
      confirm: true,
    },
    human,
  );
  assert.equal(removed.state, "removed");
  for (const credential of [grant, nonHolderGrant]) {
    for (const [type, parameters] of [
      ["execution_get", { ...key, executionId: execution.executionId }],
      [
        "execution_log_read",
        { ...key, executionId: execution.executionId, cursor: null, limitBytes: 65536 },
      ],
      ["execution_list", { ...key, limit: 20 }],
    ] as const)
      await rejected(type, parameters, "lease_not_holder", credential);
    for (const [type, parameters] of [
      [
        "execution_cancel",
        {
          ...key,
          executionId: execution.executionId,
          authorizationGeneration: 6,
          requestId: req(),
        },
      ],
      ["execution_submit", input],
    ] as const)
      await rejected(type, parameters, "membership_removed", credential);
  }
  const history = getExecution({ ...key, executionId: execution.executionId }, human);
  assert.equal(history.state, "succeeded");
  assert.equal(history.authority, "history");
  assert.equal(history.currentAuthorizationGeneration, null);
  assert.equal(history.holderInstanceId, actor.instanceId);
  rejoinProjectMachine(
    { ...key, requestId: req(), expectedEpoch: 1, expectedRevision: 1, confirm: true },
    human,
  );
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    expectedGeneration: 7,
    requestId: req(),
  });
  facts.P4dContinuity = {
    originGeneration: 1,
    inheritedCurrentGeneration: 6,
    originalHolderPreserved: true,
    getLogListReadOverHttp: true,
    oldHolderReadsWritesAndReplayRejected: true,
    removedAgentGetLogListCancelReplayRejected: true,
    humanOriginalSuccessPreserved: true,
  };
  pass(
    "P4d HTTP handoff inherits get/log/list, keeps origin, rejects old holder and removed Agent paths; Human history retains success",
  );
  await control("revoke", actor.runId);
  await rejected("lease_get", key, "remote_grant_invalid", grant, 401);
  const retainedLease = sqlite
    .prepare("SELECT state,generation FROM machine_lease WHERE project_id=? AND machine_id=?")
    .get(projectId, machineId) as { state: string; generation: number };
  assert.equal(retainedLease.state, "held");
  assert.equal(retainedLease.generation, 8);
  assert(existsSync(counter));
  assert.equal(
    (await good<{ lease: LeaseView }>("lease_get", { projectId: projectB, machineId }, grantB))
      .lease.generation,
    1,
  );
  facts.grantRevocation = { leaseRetained: true, generation: 8, filesPreserved: true };
  pass("grant revocation rejects HTTP without releasing leases or deleting files");
  await control("cleanup");
  await stop(server);
  writeFileSync(
    join(directory, "evidence.json"),
    JSON.stringify(
      {
        checks,
        facts,
        ports: [port, proxyPort],
        logs,
        privateDataExcluded: true,
        limitations: [
          "Cross-machine network and physical soft keyboard not tested.",
          "Grant issuance uses private IPC invoking the real server issuer with real PiSessionProcess; model execution and extension injection belong to tools integration.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`evidence: ${directory}/evidence.json`);
} finally {
  if (server?.connected) await control("cleanup").catch(() => {});
  for (const child of children.reverse()) await stop(child);
  await browser?.close();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
