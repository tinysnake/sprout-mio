import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { LeaseView } from "../../src/contracts/lease";
import type { AppResult } from "../../src/contracts/result";

assert.equal(process.platform, "darwin", "real macOS Worker required");
if (!existsSync(".output/server/index.mjs") || !existsSync("dist/worker/main.js")) {
  const missing = [
    [".output/server/index.mjs", ["pnpm", "build"]],
    ["dist/worker/main.js", ["pnpm", "worker:build"]],
  ] as const;
  for (const [path, command] of missing) {
    if (existsSync(path)) continue;
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
    assert.equal(result.status, 0, `${command.join(" ")} failed while restoring ${path}`);
  }
}
mkdirSync(".verify", { recursive: true });
const directory = mkdtempSync(resolve(".verify/ab-worker-long-command-"));
const children: ReturnType<typeof spawn>[] = [],
  logs: string[] = [],
  checks: string[] = [];
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  message: string | (() => string),
  ms = 60000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timeout: ${typeof message === "function" ? message() : message}`);
}
async function freePort(except: number[] = []) {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((res) => server.close(() => res()));
  assert.notEqual(port, 3000);
  assert(!except.includes(port));
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const state = join(directory, "private-state");
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
function pass(name: string) {
  checks.push(name);
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
type LogFrameObservation = {
  executionId: string;
  sequence: number;
  stream: string;
  byteStart: number;
  byteEnd: number;
  dispatchSeq: number;
  carrierSeq: number;
};
type RecoveryObservation = {
  executionId: string;
  observedState: string;
  producedThroughSequence: number | null;
  tokenShaped: boolean;
};
/** 只记录位点与形状，不记录日志正文与 token 正文。 */
const observedFrames: LogFrameObservation[] = [];
/** 网关对每次上行 exchange 的判决；失败时用它代替裸超时。 */
const exchangeVerdicts: { seq: number; code: string }[] = [];
const observedRecoveries: RecoveryObservation[] = [];
/** 只统计宿主真实下发的 ACK 数量，不注入。 */
let hostAcks = 0;
/**
 * 宿主侧目前没有 max_runtime_ms 入参（属于 p4c-tools / p4c-execution）。本脚本在代理层
 * 给指定执行的下发命令补上运行上限字段，其余命令形状与真实下发的完全一致。
 */
let injectRuntime: { executionId: string; ms: number } | null = null;
const proxyPort = await freePort([port]);
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = Buffer.concat(chunks);
    const upstream = await fetch(base + request.url!, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const parsed = (await upstream.json()) as {
      ok: boolean;
      data?: { remote?: { logFrames?: unknown[]; recoveries?: unknown[] }; mode?: string };
    };
    if (request.url === "/api/worker/exchange" && !parsed.ok)
      exchangeVerdicts.push({
        seq: (JSON.parse(body.toString("utf8")) as { seq: number }).seq,
        code: (parsed as { error?: { code?: string } }).error?.code ?? "unknown",
      });
    if (request.url === "/api/worker/exchange" && parsed.ok) {
      const input = JSON.parse(body.toString("utf8")) as {
        seq: number;
        remote?: {
          logFrames?: {
            executionId: string;
            sequence: number;
            stream: string;
            byteStart: number;
            byteEnd: number;
            dispatchSeq: number;
          }[];
          recoveries?: {
            executionId: string;
            observedState: string;
            producedThroughSequence: number | null;
            runnerToken: string;
          }[];
        };
      };
      for (const frame of input.remote?.logFrames ?? [])
        observedFrames.push({
          executionId: frame.executionId,
          sequence: frame.sequence,
          stream: frame.stream,
          byteStart: frame.byteStart,
          byteEnd: frame.byteEnd,
          dispatchSeq: frame.dispatchSeq,
          carrierSeq: input.seq,
        });
      for (const recovery of input.remote?.recoveries ?? [])
        observedRecoveries.push({
          executionId: recovery.executionId,
          observedState: recovery.observedState,
          producedThroughSequence: recovery.producedThroughSequence,
          tokenShaped: /^[0-9a-f]{32}$/.test(recovery.runnerToken),
        });
      const pendingRuntime = injectRuntime;
      if (pendingRuntime) {
        const commands = (
          parsed.data?.remote as { commands?: { executionId: string }[] } | undefined
        )?.commands;
        for (const command of commands ?? [])
          if (command.executionId === pendingRuntime.executionId) {
            Object.assign(command, {
              maxRuntimeMs: pendingRuntime.ms,
              runtimeDeadlineAt: new Date(Date.now() + pendingRuntime.ms).toISOString(),
            });
            injectRuntime = null;
          }
      }
      // 宿主自己回 ACK 并落盘日志；这里只统计下行 ACK，绝不补发（补发会让脚本假绿）。
      if (parsed.data?.remote)
        hostAcks += ((parsed.data.remote as { logAcks?: unknown[] }).logAcks ?? []).length;
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(JSON.stringify(parsed));
  } catch {
    response.writeHead(502);
    response.end();
  }
});
await new Promise<void>((res) => proxy.listen(proxyPort, "127.0.0.1", res));
const workerBase = `http://127.0.0.1:${proxyPort}`;
let server: ReturnType<typeof spawn> | undefined;
async function control(action: "issue" | "revoke" | "cleanup", runId?: string) {
  assert(server?.connected);
  const id = randomUUID();
  return new Promise<RemoteToolGrant | undefined>((res, rej) => {
    const timer = setTimeout(() => {
      server!.off("message", receive);
      rej(new Error("grant control timeout"));
    }, 15000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      server!.off("message", receive);
      if (message.ok) res(message.grant);
      else rej(new Error("private grant control failed"));
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
      email: `long-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Long command verifier",
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
  const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const projectId = newId(ID_PREFIXES.project),
    otherProjectId = newId(ID_PREFIXES.project);
  for (const project of [projectId, otherProjectId])
    sqlite
      .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Long command',?)")
      .run(project, account.user.id);
  const actor = seedRemoteActor(sqlite, account.user.id, projectId, bootId, false);
  const otherActor = seedRemoteActor(sqlite, account.user.id, otherProjectId, bootId, false);
  const now = () => ({ ...actor, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "Long command macOS" }, now());
  const machineId = machine.detail.machine.id,
    key = { projectId, machineId };
  saveProjectMachineBinding({ ...key, description: "long command", expectedRevision: null }, now());
  saveProjectMachineBinding(
    { projectId: otherProjectId, machineId, description: "other project", expectedRevision: null },
    now(),
  );
  sqlite
    .prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?")
    .run(actor.runId);
  const grant = (await control("issue", actor.runId))!;
  const otherGrant = (await control("issue", otherActor.runId))!;
  const req = () => newId(ID_PREFIXES.request);
  async function call<T>(type: string, input: unknown, credential: RemoteToolGrant | null = grant) {
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
  async function good<T>(type: string, input: unknown, credential = grant): Promise<T> {
    const { status, result } = await call<T>(type, input, credential);
    assert.equal(status, 200);
    if (!result.ok) throw new Error(`HTTP operation rejected: ${result.error.code}`);
    return result.data;
  }
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), actor.runId);
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    requestId: req(),
    expectedGeneration: 0,
  });
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      workerBase,
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
  const workerSeq = () =>
    (
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId) as { seq: number } | undefined
    )?.seq ?? 0;
  let worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
  await until(() => workerSeq() >= 1, "Worker heartbeat");
  const get = (id: string) => good<ExecutionView>("execution_get", { ...key, executionId: id });
  const submitGeneration = (operation: Record<string, unknown>, generation: number) =>
    good<ExecutionView>("execution_submit", {
      ...key,
      requestId: req(),
      authorizationGeneration: generation,
      operation,
    });
  const submit = (operation: Record<string, unknown>) => submitGeneration(operation, 1);
  const rejection: Record<string, string> = {};

  // 1. 真实长命令：循环输出 + sleep，日志帧增量上行且位点单调。
  const marker = join(directory, "stream-marker");
  const longExecution = await submit({
    kind: "shell",
    command: `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf 'line-%03d\\n' "$i"; printf 'err-%03d\\n' "$i" >&2; sleep 0.4; done; printf done > '${marker}'`,
    cwd: directory,
    waitMs: 10000,
  });
  await until(() => existsSync(marker), "long command completion", 60000);
  await until(
    async () => (await get(longExecution.executionId)).state === "succeeded",
    () => `long command terminal; gateway verdicts=${JSON.stringify(exchangeVerdicts.slice(0, 4))}`,
    30000,
  );
  const own = observedFrames.filter((frame) => frame.executionId === longExecution.executionId);
  assert(own.length >= 2, `real Worker must send incremental frames, saw ${own.length}`);
  const sequences = own.map((frame) => frame.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  assert.equal(new Set(sequences).size, sequences.length, "one monotonic sequence across streams");
  assert.deepEqual(
    [...new Set(own.map((frame) => frame.stream))].sort(),
    ["stderr", "stdout"],
    "both streams share the single sequence",
  );
  for (const frame of own) assert(frame.byteEnd >= frame.byteStart);
  for (const stream of new Set(own.map((frame) => frame.stream))) {
    const offsets = own.filter((frame) => frame.stream === stream).map((frame) => frame.byteStart);
    assert.deepEqual(
      offsets,
      [...offsets].sort((a, b) => a - b),
    );
  }
  const view = await get(longExecution.executionId);
  // 只断言「Worker 发了帧」会漏掉宿主整批拒收（合并期真实发生过）：必须看到落盘。
  const hostStored = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM execution_log_frame WHERE execution_id=?")
      .get(longExecution.executionId) as { n: number }
  ).n;
  assert(hostStored > 0, "host must persist the frames the Worker sent");
  assert.notEqual(view.logState, "none", "host log_state must leave none once frames landed");
  assert(view.producedThroughSequence !== null, "host must record produced_through_seq");
  // 关键反证：帧在命令下发之后的批次上行，仍被宿主接受。
  // 纠正前契约要求 frame.dispatchSeq === 本批 seq，这种帧根本无法发出。
  const dispatchSeq = view.dispatchSeq;
  assert(dispatchSeq !== null, "dispatched execution must carry its dispatch seq");
  const carrierSeqs = [...new Set(own.map((frame) => frame.carrierSeq))];
  assert(
    carrierSeqs.some((seq) => seq > dispatchSeq),
    `frames must ride batches later than dispatch seq ${dispatchSeq}, saw ${carrierSeqs.join(",")}`,
  );
  assert(
    own.every((frame) => frame.dispatchSeq === dispatchSeq),
    "frames must keep the dispatching batch seq, not the carrying batch seq",
  );
  facts.logging = {
    frames: own.length,
    hostStoredFrames: hostStored,
    streams: [...new Set(own.map((frame) => frame.stream))].sort(),
    firstSequence: sequences[0],
    lastSequence: sequences.at(-1),
    dispatchSeq,
    carrierSeqs,
    logState: view.logState,
    producedThroughSequence: view.producedThroughSequence,
  };
  pass("real Worker long command sends incremental log frames with monotonic byte offsets");

  // 2. ACK 后不重发：同一 execution 已确认的序号不再出现在后续 exchange 里。
  const ackedThrough = Math.max(...sequences);
  const observedBeforeAck = observedFrames.length;
  await sleep(7000);
  // 只看 ACK 生效之后的 exchange：此前那几次上行本来就是首次发送。
  const resent = observedFrames
    .slice(observedBeforeAck)
    .filter(
      (frame) => frame.executionId === longExecution.executionId && frame.sequence <= ackedThrough,
    );
  assert.equal(resent.length, 0, "acknowledged frames must not be resent");
  // 宿主确认终态后 outbox 整条清理；仍在收敛的 outbox 也必须只留未确认序号。
  const framesPath = join(state, "executions", longExecution.executionId, "frames.jsonl");
  const durableFrames = existsSync(framesPath)
    ? readFileSync(framesPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
    : [];
  const unconfirmed = durableFrames.filter(
    (line) => (JSON.parse(line) as { sequence: number }).sequence > ackedThrough,
  );
  assert.equal(unconfirmed.length, 0, "acknowledged prefix must be pruned from the outbox");
  facts.acknowledgement = {
    ackedThrough,
    resentCount: resent.length,
    hostAcks,
    remainingOutboxLines: durableFrames.length,
  };
  pass("acknowledged log prefix is pruned and never resent by the real Worker");

  // 3. 旧授权代次的新调度被拒（此时没有未收敛的执行，fence 能真正收敛）。
  const release = await good<{ state: string }>("lease_mutate", {
    ...key,
    action: "release",
    expectedGeneration: 1,
    requestId: req(),
  });
  // 长命令已经收敛，fence 可以立即完成；未收敛时会停在 pending。
  assert(["pending", "completed"].includes(release.state));
  await until(
    async () => (await good<{ lease: LeaseView }>("lease_get", key)).lease.generation === 2,
    "fence drain",
    40000,
  );
  const stale = await call("execution_submit", {
    ...key,
    requestId: req(),
    authorizationGeneration: 1,
    operation: { kind: "shell", command: "true", cwd: directory, waitMs: 1000 },
  });
  assert.equal(stale.result.ok, false);
  rejection.oldGeneration = stale.result.ok ? "accepted" : stale.result.error.code;
  assert.equal(rejection.oldGeneration, "lease_stale_generation");

  // 4. 运行上限到期先 TERM 后 KILL：忽略 TERM 的进程只在宽限后停下。
  const killMarker = join(directory, "kill-marker"),
    pidFile = join(directory, "stubborn-pid");
  await good("lease_mutate", {
    ...key,
    action: "acquire",
    requestId: req(),
    expectedGeneration: 2,
  });
  const stubborn = await submitGeneration(
    {
      kind: "shell",
      command: `echo $$ > '${pidFile}'; trap '' TERM; sleep 40; printf done > '${killMarker}'`,
      cwd: directory,
      waitMs: 1000,
    },
    3,
  );
  injectRuntime = { executionId: stubborn.executionId, ms: 1500 };
  await until(() => existsSync(pidFile), "stubborn shell started", 30000);
  const stubbornPid = Number(readFileSync(pidFile, "utf8"));
  const startedAt = Date.now();
  await until(() => !alive(stubbornPid), "stubborn shell terminated", 40000);
  const elapsed = Date.now() - startedAt;
  assert(!existsSync(killMarker), "runtime limit must stop the command before it finishes");
  assert(elapsed >= 1500, `TERM grace must precede KILL, observed ${elapsed}ms`);
  facts.runtimeLimit = { elapsedMs: elapsed, markerAbsent: true };
  pass("runtime limit delivers TERM before KILL on the real macOS Worker");

  // 5. runner_token 落盘，跨重启可报恢复事实：长跑命令在 Worker 重启时仍未退出。
  const runningMarker = join(directory, "running-marker");
  const detached = await submitGeneration(
    {
      kind: "shell",
      command: `echo $$ > '${runningMarker}'; sleep 25`,
      cwd: directory,
      waitMs: 1000,
    },
    3,
  );
  // 宿主侧生成 runner_token 属 p4c-execution（本单元不改服务端）；这里按契约形状
  // 直接写库填充，真实下发的 remoteCommand 与真实 Worker 都走原路径。
  const runnerToken = randomBytes(16).toString("hex");
  sqlite
    .prepare("UPDATE remote_execution SET runner_token=? WHERE id=? AND state='queued'")
    .run(runnerToken, detached.executionId);
  sqlite
    .prepare("UPDATE remote_execution SET runner_token=? WHERE id=? AND state='queued'")
    .run(randomBytes(16).toString("hex"), longExecution.executionId);
  await until(() => existsSync(runningMarker), "detached command started", 30000);
  const detachedPid = Number(readFileSync(runningMarker, "utf8"));
  const claimsRoot = join(state, "executions");
  const claimPath = join(claimsRoot, detached.executionId, "claim.json");
  await until(() => existsSync(claimPath), "durable claim written", 20000);
  const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
    runnerToken: string | null;
    pid: number;
  };
  assert.equal(claim.pid, detachedPid, "claim records the real child pid");
  assert.equal(claim.runnerToken, runnerToken, "runner token persists in the durable claim");
  await stop(worker);
  await until(() => worker.exitCode !== null, "worker stop for restart");
  assert(alive(detachedPid), "disconnect must not kill the running child process");
  const recoveriesBefore = observedRecoveries.length;
  worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker-recovery.log");
  await until(() => workerSeq() >= 2, "worker reconnect");
  await until(
    () => observedRecoveries.length > recoveriesBefore,
    "recovery facts on the new session",
    30000,
  );
  const recovery = observedRecoveries
    .slice(recoveriesBefore)
    .find((fact) => fact.executionId === detached.executionId);
  assert(recovery, "recovery fact for the still-running execution");
  assert.equal(recovery.tokenShaped, true, "recovery carries a shaped runner token");
  assert.equal(recovery.observedState, "running", "a live child is reported as running");
  facts.recovery = {
    observedState: recovery.observedState,
    producedThroughSequence: recovery.producedThroughSequence,
    tokenShaped: recovery.tokenShaped,
    childAliveAfterRestart: true,
  };
  pass(
    "runner_token persists across a real Worker restart and a live child is reported as running",
  );
  try {
    process.kill(detachedPid, "SIGKILL");
  } catch {
    // 已经退出。
  }

  // 6. 跨 Project 不得借租约操作他人 Machine。
  const crossRead = await call(
    "execution_get",
    { projectId: otherProjectId, machineId, executionId: longExecution.executionId },
    otherGrant,
  );
  assert.equal(crossRead.result.ok, false);
  rejection.crossProjectRead = crossRead.result.ok ? "accepted" : crossRead.result.error.code;
  const crossSubmit = await call(
    "execution_submit",
    {
      projectId: otherProjectId,
      machineId,
      requestId: req(),
      authorizationGeneration: 1,
      operation: { kind: "shell", command: "true", cwd: directory, waitMs: 1000 },
    },
    grant,
  );
  assert.equal(crossSubmit.result.ok, false);
  rejection.crossProjectSubmit = crossSubmit.result.ok ? "accepted" : crossSubmit.result.error.code;
  pass("old authorization generation and cross-Project access are rejected by the real server");

  // 7. 撤权后新调度被拒且不伪装成功。
  await control("revoke", actor.runId);
  const revoked = await call("execution_submit", {
    ...key,
    requestId: req(),
    authorizationGeneration: 3,
    operation: { kind: "shell", command: "true", cwd: directory, waitMs: 1000 },
  });
  assert.equal(revoked.result.ok, false);
  rejection.afterRevocation = revoked.result.ok ? "accepted" : revoked.result.error.code;
  const succeeded = sqlite
    .prepare(
      "SELECT COUNT(*) AS total FROM remote_execution WHERE machine_id=? AND state='succeeded'",
    )
    .get(machineId) as { total: number };
  assert.equal(succeeded.total, 1, "only the genuinely successful long command is succeeded");
  facts.revocation = { code: rejection.afterRevocation, succeededRows: succeeded.total };
  pass("revocation rejects new scheduling without faking success");

  // 8. 日志帧与 outbox 不含 token、票据或 .env 正文。
  const outbox = readdirSync(claimsRoot)
    .map((name) =>
      ["claim.json", "frames.jsonl"]
        .map((file) => {
          const path = join(claimsRoot, name, file);
          return existsSync(path) ? readFileSync(path, "utf8") : "";
        })
        .join("\n"),
    )
    .join("\n");
  for (const forbidden of [machine.ticket, "BETTER_AUTH_SECRET", "DATABASE_URL", "sleep 40"])
    assert.equal(outbox.includes(forbidden), false, "outbox must not carry secrets or commands");
  assert.equal(outbox.includes("trap '' TERM"), false, "outbox must not carry the command text");
  facts.noSecrets = { checked: 4, contains: false };
  pass("worker outbox, claims and log frames carry no ticket, secret, env or command text");

  await stop(worker);
  await control("cleanup");
  await stop(server);
  writeFileSync(
    join(directory, "evidence.json"),
    JSON.stringify(
      {
        checks,
        facts,
        rejections: rejection,
        logs,
        privateDataExcluded: true,
        limitations: [
          "宿主侧日志落盘与 remote_execution 的日志位点维护属于 p4c-execution：本脚本经代理补发已落盘前缀的 logAck（ACK 不携带正文），运行上限字段同样在代理层写入下发命令。",
          "宿主目前没有 max_runtime_ms 入参，也没有 runner_token 生成：两者按契约形状由 fixture 在库里填写，下发命令与 Worker 执行走真实路径。因此 ExecutionView 的 logState / producedThroughSequence 仍为宿主侧未实现值（none/null）。",
          "取消投递未覆盖：取消入队属于 p4c-execution。",
          "Cross-machine network and physical soft keyboard not tested.",
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
  await new Promise<void>((res) => proxy.close(() => res()));
}
