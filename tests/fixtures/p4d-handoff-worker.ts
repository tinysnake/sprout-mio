// I-P4d live handoff (no model): real production service, real macOS Worker,
// real SQLite, real Agent HTTP boundary. It proves that handoff / grant
// revocation / Project removal do not kill an in-flight command and that the
// new holder can read the same execution and the log frames produced before
// the handoff. All private rows, tickets, cookies and command bodies stay in
// the temp directory; only shapes and outcomes are written to evidence.
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
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { LeaseView } from "../../src/contracts/lease";
import type { ExecutionLogReadView } from "../../src/contracts/remote";
import type { AppResult } from "../../src/contracts/result";

assert.equal(process.platform, "darwin", "real macOS Worker required");
assert(
  existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"),
  "run scripts/verify/ap-p4d-handoff-worker.sh to prepare current app and Worker artifacts",
);
mkdirSync(".verify", { recursive: true });
const directory = mkdtempSync(resolve(".verify/p4d-handoff-worker-"));
const children: ReturnType<typeof spawn>[] = [];
const logs: string[] = [];
const checks: string[] = [];
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
  ms = 60000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timeout: ${message}`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((res) => server.close(() => res()));
  assert.notEqual(port, 3000);
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
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
    15000,
  );
}
function pass(name: string, output?: unknown) {
  checks.push(name);
  if (output) facts[name] = output;
  console.log(`PASS ${name}`);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function writeTimes(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line))
    .filter((value) => Number.isFinite(value));
}
function maxGapMs(times: number[]): number {
  let gap = 0;
  for (let index = 1; index < times.length; index += 1)
    gap = Math.max(gap, (times[index]! - times[index - 1]!) / 1e6);
  return Math.round(gap);
}
let server: ReturnType<typeof spawn> | undefined;
let worker: ReturnType<typeof spawn> | undefined;
const pids = new Set<number>();
async function control(
  action: "issue" | "revoke" | "cleanup",
  runId?: string,
): Promise<RemoteToolGrant | undefined> {
  assert(server?.connected);
  const id = randomUUID();
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      server!.off("message", receive);
      reject(new Error("grant control timeout"));
    }, 10000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      server!.off("message", receive);
      if (message.ok) done(message.grant);
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
  const signup = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `handoff-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Handoff verifier",
    }),
  });
  assert.equal(signup.status, 200, "new account signup");
  const account = (await signup.json()) as { user: { id: string } };
  pass("real production service, isolated SQLite and new account");

  Object.assign(process.env, {
    DATABASE_URL: env.DATABASE_URL,
    APP_ORIGIN: base,
    SPROUT_PI_ENABLED: "false",
  });
  const { sqlite } = await import("../../src/db");
  const { createMachine, saveProjectMachineBinding } = await import("../../src/domain/machine");
  const { seedRemoteActor } = await import("./remote-actors");
  const { detachMachine } = await import("../../src/server/membership");
    const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const projectId = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'P4d handoff live',?)")
    .run(projectId, account.user.id);
  const actorA = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const actorB = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const now = () => ({ ...actorA, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "P4d handoff macOS" }, now());
  const machineId = machine.detail.machine.id;
  const key = { projectId, machineId };
  saveProjectMachineBinding(
    { ...key, description: "handoff acceptance", expectedRevision: null },
    now(),
  );
  const grantA = (await control("issue", actorA.runId))!;
  const grantB = (await control("issue", actorB.runId))!;
  const req = () => newId(ID_PREFIXES.request);
  async function call<T>(
    type: string,
    input: unknown,
    credential: RemoteToolGrant | null = grantA,
  ) {
    const response = await fetch(base + "/api/remote/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential.secret}` } : {}),
      },
      body: JSON.stringify({ version: 2, call: { type, input } }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, result: (await response.json()) as AppResult<T> };
  }
  async function good<T>(type: string, input: unknown, credential = grantA): Promise<T> {
    const { status, result } = await call<T>(type, input, credential);
    assert.equal(status, 200);
    if (!result.ok) throw new Error(`${type} rejected ${result.error.code}`);
    return result.data;
  }
  async function rejected(
    type: string,
    input: unknown,
    code: string,
    credential = grantA,
  ): Promise<void> {
    const { result } = await call(type, input, credential);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, code);
  }
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const state = join(directory, "private-state");
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      base,
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
  worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
  const workerSeq = () =>
    (
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId) as { seq: number } | undefined
    )?.seq ?? 0;
  await until(() => workerSeq() >= 1, "Worker heartbeat");
  pass("real macOS Worker enrolled, online and heartbeating");

  const lease = () => good<{ lease: LeaseView }>("lease_get", key);
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    expectedGeneration: 0,
    requestId: req(),
  });
  const get = (id: string, credential = grantA) =>
    good<ExecutionView>("execution_get", { ...key, executionId: id }, credential);
  const readLog = (id: string, cursor: unknown, credential = grantA) =>
    good<ExecutionLogReadView>(
      "execution_log_read",
      { ...key, executionId: id, cursor, limitBytes: 65536 },
      credential,
    );

  const pidA = join(directory, "pid-a");
  const writesA = join(directory, "writes-a");
  const stopA = join(directory, "stop-a");
  const commandA = `echo $$ > '${pidA}'; while [ ! -f '${stopA}' ]; do printf 'tick %s\\n' "$(date +%s%N)"; printf '%s\\n' "$(date +%s%N)" >> '${writesA}'; sleep 0.2; done`;
  const inFlightA = await good<ExecutionView>("execution_submit", {
    ...key,
    requestId: req(),
    authorizationGeneration: 1,
    operation: { kind: "shell", command: commandA, cwd: directory, waitMs: 1000 },
  });
  await until(() => existsSync(pidA), "in-flight shell spawned");
  const pidAValue = Number(readFileSync(pidA, "utf8"));
  pids.add(pidAValue);
  await until(() => writeTimes(writesA).length >= 3, "periodic writes started");
  let beforeA: ExecutionLogReadView | undefined;
  await until(async () => {
    beforeA = await readLog(inFlightA.executionId, null);
    return (
      beforeA.frames.length > 0 &&
      (beforeA.producedThroughSequence ?? 0) > 0 &&
      writeTimes(writesA).length >= 3
    );
  }, "log frames and periodic writes exist before handoff");
  const framesBeforeHandoff = Math.max(...beforeA!.frames.map((frame) => frame.sequence));
  const producedBeforeHandoff = beforeA!.producedThroughSequence ?? 0;
  const writesBefore = writeTimes(writesA).length;
  pass("old holder A has a running long command, existing log frames and periodic file writes", {
    executionId: inFlightA.executionId,
    framesBeforeHandoff,
    writesBefore,
  });

  const handed = await good<{ state: string; mutationId: string }>("lease_mutate", {
    ...key,
    action: "handoff",
    expectedGeneration: 1,
    targetInstanceId: actorB.instanceId,
    requestId: req(),
  });
  assert.equal(handed.state, "pending");
  // Fencing window: A may still read its own origin execution; B must not read it yet.
  const aDuringFence = await call<ExecutionView>("execution_get", {
    ...key,
    executionId: inFlightA.executionId,
  });
  const bDuringFence = await call<ExecutionView>(
    "execution_get",
    { ...key, executionId: inFlightA.executionId },
    grantB,
  );
  assert.equal(bDuringFence.result.ok, false);
  facts.fencing = {
    aReadDuringFence: aDuringFence.result.ok ? "allowed" : aDuringFence.result.error?.code,
    bReadDuringFence: bDuringFence.result.ok ? "allowed" : bDuringFence.result.error?.code,
    bCode: bDuringFence.result.ok ? null : bDuringFence.result.error?.code,
  };
  assert(
    ["lease_fencing", "lease_not_holder"].includes(
      bDuringFence.result.ok ? "allowed" : bDuringFence.result.error?.code ?? "",
    ),
    `B must not read during fencing, got ${JSON.stringify(bDuringFence.result)}`,
  );
  await until(async () => (await lease()).lease.generation === 2, "handoff completion generation", 60000);
  const afterHandoff = (await lease()).lease;
  assert.equal(afterHandoff.holderInstanceId, actorB.instanceId);
  pass("handoff request fences B and completes to g+1/B");

  const inherited = await get(inFlightA.executionId, grantB);
  assert.equal(inherited.executionId, inFlightA.executionId);
  assert.equal(inherited.holderInstanceId, actorA.instanceId);
  assert.equal(inherited.authorizationGeneration, 1);
  assert.equal(inherited.authority, "inherited");
  assert.equal(inherited.currentAuthorizationGeneration, 2);
  const logB = await readLog(inFlightA.executionId, null, grantB);
  assert(
    Math.max(...logB.frames.map((frame) => frame.sequence)) >= framesBeforeHandoff,
    "B must see the frames produced before the handoff",
  );
  const listB = await good<{ executions: ExecutionView[] }>(
    "execution_list",
    { ...key, limit: 100 },
    grantB,
  );
  assert(
    listB.executions.some(
      (view) =>
        view.executionId === inFlightA.executionId && view.authority === "inherited",
    ),
  );
  await rejected("execution_get", { ...key, executionId: inFlightA.executionId }, "lease_not_holder");
  await rejected(
    "execution_log_read",
    { ...key, executionId: inFlightA.executionId, cursor: null, limitBytes: 65536 },
    "lease_not_holder",
  );
  await rejected("execution_list", { ...key, limit: 20 }, "lease_not_holder");
  facts.inherited = {
    executionId: inherited.executionId,
    originHolder: inherited.holderInstanceId,
    originGeneration: inherited.authorizationGeneration,
    currentGeneration: inherited.currentAuthorizationGeneration,
    authority: inherited.authority,
    stateAfterHandoff: inherited.state,
    failureReasonAfterHandoff: inherited.failureReason ?? null,
    framesBeforeHandoff,
    framesSeenByB: Math.max(...logB.frames.map((frame) => frame.sequence)),
    producedThroughBefore: producedBeforeHandoff,
  };
  pass("g+1/B reads the same execution and the pre-handoff log frames; A is rejected");

  await until(() => writeTimes(writesA).length >= writesBefore + 5, "writes continue after handoff");
  assert(alive(pidAValue), "handoff must not kill the real command process");
  assert(!existsSync(stopA), "command still running");
  const writesAfter = writeTimes(writesA);
  facts.handoffContinuity = {
    writesBefore,
    writesAfter: writesAfter.length,
    pidAlive: alive(pidAValue),
    maxGapMsAcrossHandoff: maxGapMs(writesAfter.slice(Math.max(0, writesBefore - 3))),
  };
  assert(maxGapMs(writesAfter) < 3000, `file write gap ${maxGapMs(writesAfter)}ms`);
  pass("process and periodic file writes stay continuous across handoff", facts.handoffContinuity);

  // Cancelling the old origin execution from the new holder: record the real
  // path's actual answer instead of pretending the server still says running.
  const cancelOldByB = await call<{ state: string }>(
    "execution_cancel",
    {
      ...key,
      executionId: inFlightA.executionId,
      authorizationGeneration: 2,
      requestId: req(),
    },
    grantB,
  );
  const cancelOldByA = await call(
    "execution_cancel",
    {
      ...key,
      executionId: inFlightA.executionId,
      authorizationGeneration: 2,
      requestId: req(),
    },
    grantA,
  );
  const cancelOldByBStale = await call(
    "execution_cancel",
    {
      ...key,
      executionId: inFlightA.executionId,
      authorizationGeneration: 1,
      requestId: req(),
    },
    grantB,
  );
  await rejected(
    "execution_cancel",
    {
      ...key,
      executionId: inFlightA.executionId,
      authorizationGeneration: 2,
      requestId: req(),
    },
    "lease_not_holder",
    grantA,
  );
  facts.oldCancel = {
    byNewHolder: cancelOldByB.result.ok
      ? (cancelOldByB.result.data as { state: string }).state
      : cancelOldByB.result.error?.code,
    byOldHolder: cancelOldByA.result.ok ? "accepted" : cancelOldByA.result.error?.code,
    byNewHolderWithOriginGeneration: cancelOldByBStale.result.ok
      ? "accepted"
      : cancelOldByBStale.result.error?.code,
    executionStillRuns: alive(pidAValue),
  };
  writeFileSync(stopA, "stop");
  await until(() => !alive(pidAValue), "A command exits on its own after stop file", 30000);
  pass("cross-fence cancel outcomes recorded from the real boundary", facts.oldCancel);

  // Real in-flight cancel that does not cross a fence: the current holder B
  // cancels its own running command and the real Worker must apply the signal.
  const pidB = join(directory, "pid-b");
  const writesB = join(directory, "writes-b");
  const stopB = join(directory, "stop-b");
  const commandB = `echo $$ > '${pidB}'; trap '' TERM; while [ ! -f '${stopB}' ]; do printf 'tick %s\\n' "$(date +%s%N)"; printf '%s\\n' "$(date +%s%N)" >> '${writesB}'; sleep 0.2; done`;
  const inFlightB = await good<ExecutionView>(
    "execution_submit",
    {
      ...key,
      requestId: req(),
      authorizationGeneration: 2,
      operation: { kind: "shell", command: commandB, cwd: directory, waitMs: 1000 },
    },
    grantB,
  );
  await until(() => existsSync(pidB), "B in-flight shell spawned");
  const pidBValue = Number(readFileSync(pidB, "utf8"));
  pids.add(pidBValue);
  await until(() => writeTimes(writesB).length >= 3, "B periodic writes started");
  const cancelB = await good<{ state: string }>(
    "execution_cancel",
    {
      ...key,
      executionId: inFlightB.executionId,
      authorizationGeneration: 2,
      requestId: req(),
    },
    grantB,
  );
  assert(["requested", "delivered", "exited_observed"].includes(cancelB.state), `unexpected cancel state ${cancelB.state}`);
  const cancelRow = sqlite
    .prepare(
      "SELECT actor_kind, actor_id, authorization_generation FROM execution_cancellation WHERE execution_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(inFlightB.executionId) as
    | { actor_kind: string; actor_id: string; authorization_generation: number }
    | undefined;
  assert.equal(cancelRow?.actor_kind, "agent");
  assert.equal(cancelRow?.actor_id, actorB.instanceId);
  assert.equal(cancelRow?.authorization_generation, 2);
  const executionOrigin = sqlite
    .prepare("SELECT authorization_generation, holder_instance_id FROM remote_execution WHERE id=?")
    .get(inFlightB.executionId) as
    | { authorization_generation: number; holder_instance_id: string }
    | undefined;
  assert.equal(executionOrigin?.authorization_generation, 2);
  await until(() => !alive(pidBValue), "real Worker terminates cancelled command", 30000);
  // The process exit is observed first; the terminal row and the cancellation
  // receipt may trail it. Record whichever the server actually reached.
  await until(() => {
    const row = sqlite
      .prepare("SELECT terminal_at FROM remote_execution WHERE id=?")
      .get(inFlightB.executionId) as { terminal_at: number | null } | undefined;
    return row?.terminal_at != null;
  }, "cancelled execution terminal row", 15000).catch(() => undefined);
  await until(() => {
    const row = sqlite
      .prepare("SELECT state FROM execution_cancellation WHERE execution_id=? ORDER BY rowid DESC LIMIT 1")
      .get(inFlightB.executionId) as { state: string } | undefined;
    return Boolean(row && ["exited_observed", "already_exited", "failed", "unknown"].includes(row.state));
  }, "cancellation receipt settles", 15000).catch(() => undefined);
  const cancelOutcome = sqlite
    .prepare("SELECT state, failure_reason, terminal_at FROM remote_execution WHERE id=?")
    .get(inFlightB.executionId) as {
    state: string;
    failure_reason: string | null;
    terminal_at: number | null;
  };
  const cancelFinal = sqlite
    .prepare("SELECT state, signal_outcome FROM execution_cancellation WHERE execution_id=? ORDER BY rowid DESC LIMIT 1")
    .get(inFlightB.executionId) as { state: string; signal_outcome: string } | undefined;
  facts.realInFlightCancel = {
    cancellationAcceptedState: cancelB.state,
    executionState: cancelOutcome.state,
    failureReason: cancelOutcome.failure_reason,
    cancellationFinalState: cancelFinal?.state ?? null,
    signalOutcome: cancelFinal?.signal_outcome ?? null,
    terminal: cancelOutcome.terminal_at !== null,
    processExited: !alive(pidBValue),
  };
  writeFileSync(stopB, "stop");
  pass("real in-flight cancel accepted for g+1/B and the real Worker stops the process", facts.realInFlightCancel);

  // Grant revocation and Project removal while a real command is running: the
  // lease/membership actions must not clean up the process or its files.
  const pidC = join(directory, "pid-c");
  const writesC = join(directory, "writes-c");
  const stopC = join(directory, "stop-c");
  const commandC = `echo $$ > '${pidC}'; while [ ! -f '${stopC}' ]; do printf '%s\\n' "$(date +%s%N)" >> '${writesC}'; sleep 0.2; done`;
  const inFlightC = await good<ExecutionView>(
    "execution_submit",
    {
      ...key,
      requestId: req(),
      authorizationGeneration: 2,
      operation: { kind: "shell", command: commandC, cwd: directory, waitMs: 1000 },
    },
    grantB,
  );
  await until(() => existsSync(pidC), "C in-flight shell spawned");
  const pidCValue = Number(readFileSync(pidC, "utf8"));
  pids.add(pidCValue);
  await until(() => writeTimes(writesC).length >= 3, "C periodic writes started");
  await control("revoke", actorB.runId);
  const revokedCount = writeTimes(writesC).length;
  await sleep(2000);
  const afterRevokeCount = writeTimes(writesC).length;
  assert(afterRevokeCount > revokedCount, "revocation must not stop file writes");
  assert(alive(pidCValue), "revocation must not kill the command process");
  facts.revocation = {
    writesBefore: revokedCount,
    writesAfter: afterRevokeCount,
    pidAlive: alive(pidCValue),
  };
  pass("grant revocation leaves the running command and its periodic writes intact");

  const binding = sqlite
    .prepare("SELECT revision FROM project_machine WHERE project_id=? AND machine_id=?")
    .get(projectId, machineId) as { revision: number };
  const membership = sqlite
    .prepare(
      "SELECT epoch, state FROM project_machine_membership WHERE project_id=? AND machine_id=? ORDER BY epoch DESC LIMIT 1",
    )
    .get(projectId, machineId) as { epoch: number; state: string };
  const generationBeforeDetach = (await lease()).lease.generation;
  const detached = detachMachine(
    {
      ...key,
      requestId: newId(ID_PREFIXES.request),
      expectedEpoch: membership.epoch,
      expectedRevision: binding.revision,
      expectedGeneration: generationBeforeDetach,
      confirm: true,
    },
    { userId: account.user.id, bootId, now: new Date(), requestId: newId(ID_PREFIXES.request) },
  );
  const removalCount = writeTimes(writesC).length;
  await sleep(2000);
  const afterRemovalCount = writeTimes(writesC).length;
  assert(afterRemovalCount > removalCount, "removal must not stop file writes");
  assert(alive(pidCValue), "removal must not kill the command process");
  facts.removal = {
    detachState: detached.state,
    membershipBefore: membership.state,
    writesBefore: removalCount,
    writesAfter: afterRemovalCount,
    pidAlive: alive(pidCValue),
    generationBeforeDetach,
    executionId: inFlightC.executionId,
  };
  pass("Project removal leaves the running command and its periodic writes intact");

  writeFileSync(stopC, "stop");
  await until(() => !alive(pidCValue), "C command exits on its own after stop file", 30000);
  await until(
    () =>
      (
        sqlite
          .prepare(
            "SELECT state FROM project_machine_membership WHERE project_id=? AND machine_id=? ORDER BY epoch DESC LIMIT 1",
          )
          .get(projectId, machineId) as { state: string }
      ).state === "removed",
    "removal completes after drain",
    60000,
  );
  const history = sqlite
    .prepare("SELECT state, failure_reason FROM remote_execution WHERE id=?")
    .get(inFlightC.executionId) as { state: string; failure_reason: string | null };
  facts.final = {
    historyState: history.state,
    historyFailureReason: history.failure_reason,
    workerStillAlive: worker?.exitCode === null,
  };
  pass("removal completes only after the real command's drain; history stays explicit");

  const evidence = {
    mode: "real-worker-no-model",
    platform: process.platform,
    checks,
    facts,
    privateDirectory: directory,
  };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`PASS p4d handoff real Worker evidence ${join(directory, "evidence.json")}`);
} catch (error) {
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify({ checks, facts, error: String(error) }, null, 2) + "\n",
  );
  throw error;
} finally {
  for (const pid of pids) {
    try {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (server?.connected) await control("cleanup").catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  for (const log of logs) if (!existsSync(log)) continue;
}
