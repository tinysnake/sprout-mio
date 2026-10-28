// 真实 SQLite + 真实 OS 子进程 + 真实 Worker 侧登记表：第二轮独立验收 R1/R2/R4 的修复与反证。
// R1 走真实领域边界（enqueueCancellation / cancelExecution）；R2 与 R4 走真实协议往返：
// RemoteDispatcher 的 outbox、runner 的 claim/result 都是真实文件，命令是真实子进程。
// 私有库、runner token、state-dir 与命令正文都留在 mktemp，不进日志。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIncompleteLogState } from "../../src/components/machine/presentation";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionCancellationView } from "../../src/contracts/remote";
import type { MachineContext } from "../../src/domain/machine";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import type { AgentRemoteContext } from "../../src/server/lease";
import { acquireLease, releaseLease } from "../../src/server/lease";
import {
  cancelExecution,
  enqueueCancellation,
  getExecution,
  readExecutionLog,
  requestExecution,
} from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { ExecutionRegistry, ExecutionStore } from "../../src/worker/executions";
import { RemoteDispatcher } from "../../src/worker/remote";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
for (const user of ["owner", "stranger"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Accept2','owner')")
  .run(projectId);

const firstHolder = seedRemoteActor(sqlite, "owner", projectId, bootId);
const nextHolder = seedRemoteActor(sqlite, "owner", projectId, bootId);
const human: MachineContext = {
  userId: "owner",
  bootId,
  now: new Date(),
  requestId: newId(ID_PREFIXES.request),
};
const machine = createMachine({ name: "Accept2 Mac" }, firstHolder);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "fixture", expectedRevision: null },
  firstHolder,
);
const key = { projectId, machineId };
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const rowCount = () =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM execution_cancellation").get() as { n: number }).n;
const diagnosticCount = () =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM diagnostic_event").get() as { n: number }).n;
const suspend = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** 只看内核还认不认这个 pid：命令组没有任何残留才叫收尸完毕。 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, firstHolder);
const secret = "b".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: req() };
enrollWorker({ ...wire, ticket: machine.ticket }, firstHolder);
const stateDirectory = mkdtempSync(join(tmpdir(), "p4c-accept2-state-"));
let session = openWorker({ ...wire, attemptId: randomUUID() }, firstHolder).session;
const dispatchSession = session;
let seq = 0;
type Exchange = ReturnType<typeof exchangeWorker>;
const capability = {
  platform: "darwin" as const,
  arch: "arm64" as const,
  workerVersion: "test",
  shells: [
    {
      path: "/bin/sh",
      kind: "sh" as const,
      version: null,
      checkedAt: firstHolder.now.toISOString(),
      probe: { kind: "success" as const },
    },
  ],
  remoteOperations: ["shell" as const],
};
const exchange = (remote: Record<string, unknown> = {}) => {
  const used = ++seq;
  const response: Exchange = exchangeWorker(
    {
      version: 3,
      requestId: wire.requestId,
      secret,
      session,
      seq: used,
      mode: "normal",
      capability,
      observations: [],
      remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [], ...remote } as never,
    },
    { ...firstHolder, now: new Date() },
  );
  return { used, response };
};
exchange();
/** durable 退出证据在终态 ACK 之前快照：ACK 之后 outbox（含 result.json）就该被清掉。 */
const watched = new Set<string>();
const durableResults = new Map<string, { exitCode: number | null; signal: string | null }>();
function snapshotDurable() {
  for (const executionId of watched) {
    const path = join(stateDirectory, "executions", executionId, "result.json");
    if (!existsSync(path)) continue;
    durableResults.set(
      executionId,
      JSON.parse(readFileSync(path, "utf8")) as { exitCode: number | null; signal: string | null },
    );
  }
}
/** 一次真实往返：Worker 出站批 → 宿主领域函数 → Worker 接收宿主回复。 */
function round(worker: RemoteDispatcher) {
  const outgoing = worker.outgoing(1048576);
  const { used, response } = exchange(outgoing as never);
  snapshotDurable();
  worker.accept(response, used, []);
  return response;
}
function makeDispatcher() {
  return new RemoteDispatcher(
    session,
    capability as never,
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now),
  );
}
const shell = (command: string, waitMs = 1000) => ({
  kind: "shell" as const,
  command,
  cwd: "/tmp",
  waitMs,
});
const submit = (ctx: AgentRemoteContext, generation: number, command: string, waitMs = 1000) => {
  const submitted = requestExecution(
    {
      ...key,
      requestId: req(),
      authorizationGeneration: generation,
      operation: shell(command, waitMs),
    },
    ctx,
  );
  watched.add(submitted.executionId);
  return submitted;
};
const view = (executionId: string, ctx: AgentRemoteContext | MachineContext = firstHolder) =>
  getExecution({ ...key, executionId }, ctx);
const logOf = (executionId: string, ctx: AgentRemoteContext | MachineContext = firstHolder) =>
  readExecutionLog({ ...key, executionId, cursor: null, limitBytes: 65536 }, ctx);
const executionFiles = (executionId: string) => {
  const directory = join(stateDirectory, "executions", executionId);
  return existsSync(directory) ? readdirSync(directory) : [];
};
/** 取消事实可能被 holder 之外的读取挡住，直接在真实表上读同一条行。 */
function cancellationOf(executionId: string): ExecutionCancellationView | null {
  const row = sqlite
    .prepare("SELECT * FROM execution_cancellation WHERE execution_id = ?")
    .get(executionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const stamp = (value: unknown) => (value === null ? null : new Date(Number(value)).toISOString());
  return {
    projectId: row.project_id as string,
    machineId: row.machine_id as string,
    cancelId: row.id as ExecutionCancellationView["cancelId"],
    executionId: row.execution_id as ExecutionCancellationView["executionId"],
    state: row.state as ExecutionCancellationView["state"],
    requestedAt: stamp(row.requested_at)!,
    deliveredAt: stamp(row.delivered_at),
    exitedAt: stamp(row.exited_at),
    signalOutcome: row.signal_outcome as ExecutionCancellationView["signalOutcome"],
    failureReason: row.failure_reason as ExecutionCancellationView["failureReason"],
  };
}
/**
 * 「命令真的跑起来了」的确定性判据：runner claim 里已经有 childPid。
 * 只看 runner.json 存在会把「runner 已起、命令还没起」的那一次 spawn 宽度当成已启动。
 */
const runnerStarted = (worker: RemoteDispatcher, executionId: string) => {
  if (worker.registry.runs.get(executionId)?.started !== true) return false;
  const path = join(stateDirectory, "executions", executionId, "runner.json");
  if (!existsSync(path)) return false;
  const claimed = JSON.parse(readFileSync(path, "utf8")) as { childPid?: number | null };
  return typeof claimed.childPid === "number" && claimed.childPid > 1;
};
/** 终态报告的身份来自真实执行行；投递会话就是当初下发它的那一代。 */
function reportIdentity(executionId: string) {
  const row = sqlite.prepare("SELECT * FROM remote_execution WHERE id = ?").get(executionId) as {
    project_id: string;
    machine_id: string;
    authorization_generation: number;
    holder_instance_id: string;
    dispatch_seq: number;
    payload_hash: string;
  };
  return {
    executionId,
    projectId: row.project_id,
    machineId: row.machine_id,
    authorizationGeneration: row.authorization_generation,
    holderInstanceId: row.holder_instance_id,
    fingerprint: row.payload_hash,
    dispatchSeq: row.dispatch_seq,
    dispatchSession,
  };
}

// ── R1：取消幂等重放不得跳过代次与租约核对 ────────────────────────────────────
const cancellable = submit(firstHolder, 1, "true");
exchange();
const cancelInput = {
  ...key,
  executionId: cancellable.executionId,
  requestId: req(),
  policy: "term_then_kill" as const,
  termWaitMs: 2000,
  authorizationGeneration: 1,
};
const first = enqueueCancellation(cancelInput, firstHolder);
assert.equal(first.state, "requested");
pass("R1 正证：当前代次的取消入队为 requested");

const replay = enqueueCancellation(cancelInput, firstHolder);
assert.equal(replay.cancelId, first.cancelId);
assert.equal(replay.state, first.state);
pass("R1 正证：同代次重放返回同一 cancelId 与原状态，不新增行");

const beforeDiagnostics = diagnosticCount();
for (const generation of [2, 4])
  assert.throws(
    () => enqueueCancellation({ ...cancelInput, authorizationGeneration: generation }, firstHolder),
    fail("lease_stale_generation"),
  );
assert.equal(rowCount(), 1);
assert.equal(diagnosticCount(), beforeDiagnostics);
pass("R1 反证：幂等重放声明错代次（2 与 4）都是 lease_stale_generation，不写行、不写诊断");

// 执行到终态：终态报告先把它 drain 掉（真实租约动作要求没有未 drain 的下发）。
exchange({
  results: [
    {
      ...reportIdentity(cancellable.executionId),
      phase: "terminal",
      drained: true,
      outcome: "succeeded",
      payload: {
        kind: "shell",
        pid: 4812,
        exited: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      },
    },
  ],
});
assert.notEqual(view(cancellable.executionId).terminalAt, null);
assert.equal(cancellationOf(cancellable.executionId)!.state, "already_exited");
// 已终态的执行：同一代次的新 requestId 报已终态，而原 requestId 的幂等重放仍返回原取消事实。
assert.throws(
  () => enqueueCancellation({ ...cancelInput, requestId: req() }, firstHolder),
  fail("cancellation_already_terminal"),
);
assert.equal(enqueueCancellation(cancelInput, firstHolder).cancelId, first.cancelId);
pass(
  "R1 正证：执行已终态时，原 requestId 的同代次重放仍是同一取消事实，新 requestId 才是 already_terminal",
);

// 同一 requestId 换个分身重放：没有幂等命中，通道核对说它不是 holder。
const rowsBeforeSibling = rowCount();
assert.throws(() => enqueueCancellation(cancelInput, nextHolder), fail("lease_not_holder"));
assert.equal(rowCount(), rowsBeforeSibling);
pass("R1 反证：另一个分身拿同一 requestId 重放被拒（不是 holder），不新增取消行");

// 释放到下一代次、由另一个分身接手后，原代次与原 requestId 的重放必须被拒。
const beforeRows = rowCount();
releaseLease({ ...key, action: "release", requestId: req(), expectedGeneration: 1 }, firstHolder);
acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 2 }, nextHolder);
assert.throws(() => enqueueCancellation(cancelInput, firstHolder), fail("lease_stale_generation"));
assert.throws(
  () => enqueueCancellation({ ...cancelInput, requestId: req() }, firstHolder),
  fail("lease_stale_generation"),
);
assert.equal(rowCount(), beforeRows);
pass("R1 反证：租约换代次换 holder 后，原代次的重放与新建都被拒且不写取消行");

// 人类路径同样先核对投递通道，再决定是否幂等返回。
assert.throws(
  () =>
    cancelExecution(
      { executionId: cancellable.executionId, requestId: req() },
      { ...human, now: new Date() },
    ),
  fail("cancellation_delivery_unconfirmed"),
);
assert.equal(rowCount(), beforeRows);
pass("R1 反证：执行所属代次已换人时，人类取消不写行、也不伪装成已入队");

assert.throws(
  () =>
    cancelExecution(
      { executionId: cancellable.executionId, requestId: req() },
      { ...human, userId: "stranger", now: new Date() },
    ),
  fail("not_found"),
);
pass("R1 反证：另一用户取消同一执行是 not_found");

// ── R2：快速大输出不得丢尾部却声称完整 ────────────────────────────────────────
// 释放 + 重新 acquire 之后租约在代次 3，由 nextHolder 持有。
const generation = 3;
const burst = submit(nextHolder, generation, "head -c 1800000 /dev/zero | tr '\\0' 'x'", 1000);
const worker = makeDispatcher();
round(worker);
let producedAtSettle = -1;
let settledRound = -1;
for (let index = 0; index < 400; index++) {
  round(worker);
  const current = view(burst.executionId, nextHolder);
  if (worker.registry.runs.get(burst.executionId)?.settled === true && producedAtSettle < 0) {
    producedAtSettle = current.producedThroughSequence ?? 0;
    settledRound = index;
  }
  if (!executionFiles(burst.executionId).includes("claim.json")) break;
  await suspend(1);
}
const burstView = view(burst.executionId, nextHolder);
// 被裁剪之后，从「最早的可用起点之前」读必须被拒：旧的起点不能冒充完整历史。
assert.throws(() => logOf(burst.executionId, nextHolder), fail("execution_log_gap"));
const burstLog = readExecutionLog(
  {
    ...key,
    executionId: burst.executionId,
    cursor: {
      executionId: burst.executionId,
      nextSequence: (burstView.availableFromSequence ?? 1) - 1,
    },
    limitBytes: 65536,
  },
  nextHolder,
);
assert.notEqual(burstView.terminalAt, null, "1.8 MB 输出必须收敛到终态");
assert.equal(burstView.state, "succeeded");
assert.ok(settledRound >= 0, "终态必须在补送过程中被 ACK");
assert.ok(producedAtSettle > 8, `终态 ACK 时宿主只收到 ${producedAtSettle} 帧，仍有帧没送出去`);
assert.ok(
  producedAtSettle < (burstLog.producedThroughSequence ?? 0),
  "终态 ACK 之后仍应有未送达的帧：这证明 outbox 留到了日志 ACK，而不是随终态一起删掉",
);
assert.equal(
  burstLog.acknowledgedThroughSequence,
  burstLog.producedThroughSequence,
  "补送完成后已确认前缀必须覆盖全部已产出帧",
);
assert.equal(burstLog.logState, "truncated");
assert.ok(isIncompleteLogState(burstLog.logState), "丢掉字节的路径不得出现 logState=full");
assert.ok((burstLog.availableFromSequence ?? 1) > 1, "裁剪必须推进可用起点");
assert.deepEqual(burstLog.gapRanges, [], "前缀裁剪不是缺口，不能凭空造 gap");
assert.ok(
  !executionFiles(burst.executionId).includes("frames.jsonl"),
  "日志 ACK 覆盖全部已产出帧之后，durable outbox 才清理",
);
pass(
  `R2 正证：1.8 MB 快速输出共 ${burstLog.producedThroughSequence} 帧，终态 ACK 时只到了 ${producedAtSettle} 帧，最终 truncated + availableFrom=${burstLog.availableFromSequence}`,
);

// R2 反证：终态 ACK 后立刻重启 Worker，遗留帧仍能被新一代连接补送。
const restarted = submit(nextHolder, generation, "head -c 1800000 /dev/zero | tr '\\0' 'y'", 1000);
const beforeRestartWorker = makeDispatcher();
round(beforeRestartWorker);
let restartSettled = false;
for (let index = 0; index < 400; index++) {
  round(beforeRestartWorker);
  if (beforeRestartWorker.registry.runs.get(restarted.executionId)?.settled === true) {
    restartSettled = true;
    break;
  }
  await suspend(1);
}
const producedBeforeRestart = view(restarted.executionId, nextHolder).producedThroughSequence ?? 0;
assert.ok(restartSettled, "终态必须先被 ACK，再模拟 Worker 重启");
assert.ok(
  executionFiles(restarted.executionId).includes("frames.jsonl"),
  "终态 ACK 时 outbox 必须还在，否则补送无从谈起",
);
// 真实重启：新连接代次 + 新登记表实例，共用同一个 state-dir。
session = openWorker({ ...wire, attemptId: randomUUID() }, firstHolder).session;
seq = 0;
exchange();
const successor = makeDispatcher();
for (let index = 0; index < 400; index++) {
  round(successor);
  if (!executionFiles(restarted.executionId).includes("claim.json")) break;
  await suspend(1);
}
const restartedView = view(restarted.executionId, nextHolder);
const restartedLog = readExecutionLog(
  {
    ...key,
    executionId: restarted.executionId,
    cursor: {
      executionId: restarted.executionId,
      nextSequence: (restartedView.availableFromSequence ?? 1) - 1,
    },
    limitBytes: 65536,
  },
  nextHolder,
);
assert.ok(
  (restartedLog.producedThroughSequence ?? 0) > producedBeforeRestart,
  `重启后必须补送剩余帧：重启前 ${producedBeforeRestart}，重启后 ${restartedLog.producedThroughSequence}`,
);
assert.equal(restartedLog.logState, "truncated");
assert.equal(restartedLog.acknowledgedThroughSequence, restartedLog.producedThroughSequence);
assert.ok(!executionFiles(restarted.executionId).includes("result.json"));
pass(
  `R2 反证：终态 ACK 后立即重启 Worker，新一代连接把 ${producedBeforeRestart} → ${restartedLog.producedThroughSequence} 帧补送完`,
);

// ── R4：没有 durable result 的退出不得当成已观测 ──────────────────────────────
async function cancelAndDeliver(executionId: string, worker: RemoteDispatcher) {
  const requested = enqueueCancellation(
    {
      ...key,
      executionId,
      requestId: req(),
      policy: "term_then_kill",
      termWaitMs: 2000,
      authorizationGeneration: generation,
    },
    nextHolder,
  );
  for (let index = 0; index < 600; index++) {
    round(worker);
    const current = cancellationOf(executionId);
    if (current && current.state !== "requested") return { requested, current };
    await suspend(20);
  }
  throw new Error("timeout cancel delivery");
}
/** 边推进真实往返边等事实变化：不推 exchange，终态报告与 ACK 都不会自己到达。 */
async function pumpUntil(
  worker: RemoteDispatcher,
  condition: () => boolean,
  label: string,
  ms = 40000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    round(worker);
    if (condition()) return;
    await suspend(30);
  }
  throw new Error(`timeout ${label}`);
}
const gracefulWorker = makeDispatcher();
const graceful = submit(nextHolder, generation, "sleep 30", 500);
round(gracefulWorker);
// 取消必须发生在命令真的跑起来之后：runner 已经落盘 claim，pid 已登记。
await pumpUntil(
  gracefulWorker,
  () => runnerStarted(gracefulWorker, graceful.executionId),
  "graceful running",
);
await cancelAndDeliver(graceful.executionId, gracefulWorker);
await pumpUntil(
  gracefulWorker,
  () => cancellationOf(graceful.executionId)?.state === "exited_observed",
  "graceful cancel settle",
);
const gracefulSettled = cancellationOf(graceful.executionId)!;
assert.notEqual(gracefulSettled.exitedAt, null, "有 runner result 的取消必须记下观察到的退出");
assert.equal(gracefulSettled.failureReason, null);
pass("R4 正证：TERM 后命令自行退出且 runner 落盘结果 → 取消是 exited_observed 并带退出时间");

const stubbornWorker = makeDispatcher();
const stubborn = submit(nextHolder, generation, "trap '' TERM; sleep 30", 500);
round(stubbornWorker);
await pumpUntil(
  stubbornWorker,
  () => runnerStarted(stubbornWorker, stubborn.executionId),
  "stubborn running",
);
// runner.json 会在终态 ACK 后被清掉：命令自己的 pid 在取消前记下，收尸断言才有目标。
const stubbornRunner = JSON.parse(
  readFileSync(join(stateDirectory, "executions", stubborn.executionId, "runner.json"), "utf8"),
) as { pid: number; childPid: number | null };
assert.notEqual(stubbornRunner.childPid, null, "runner 必须记下命令自己的 pid");
await cancelAndDeliver(stubborn.executionId, stubbornWorker);
await pumpUntil(
  stubbornWorker,
  () => cancellationOf(stubborn.executionId)?.state === "exited_observed",
  "stubborn cancel settle",
);
const stubbornView = view(stubborn.executionId, nextHolder);
const stubbornCancel = cancellationOf(stubborn.executionId)!;
assert.ok(
  durableResults.has(stubborn.executionId),
  "托管分离：KILL 只打命令组，runner 必须落下 result.json",
);
assert.notEqual(stubbornCancel.exitedAt, null, "有 durable result 的取消必须记下退出时间");
assert.equal(stubbornCancel.failureReason, null);
assert.equal(stubbornView.state, "unknown", "被取消的命令不是成功也不是仍在运行");
assert.equal(stubbornView.failureReason, "authorization_revoked");
assert.equal(stubbornView.recoveryReason, null, "有 durable result 就没有未记录原因");
assert.equal(alive(stubbornRunner.childPid!), false, "KILL 之后命令组不留孤儿");
pass("R4 正证 2：忽略 TERM 的命令被 KILL，信号只打命令组，runner 落盘 → 取消仍是 exited_observed");

// ── R4 反证：只有 runner 缺席才叫「退出未被记录」 ────────────────────────────
// 确定性制造没有 result 的局面：命令收到取消后杀掉自己的 runner（`kill -9 $PPID`），
// 磁盘上永远不会出现 result.json。不靠宽限窗口的时序碰运气。
const absentSentinel = join(stateDirectory, "absent-runner-sentinel");
rmSync(absentSentinel, { force: true });
const absentWorker = makeDispatcher();
const absent = submit(
  nextHolder,
  generation,
  `echo pid=$$; trap '' TERM; while [ ! -f '${absentSentinel}' ]; do sleep 0.2; done; kill -9 $PPID; sleep 30`,
  500,
);
round(absentWorker);
await pumpUntil(
  absentWorker,
  () => runnerStarted(absentWorker, absent.executionId),
  "absent runner running",
);
await cancelAndDeliver(absent.executionId, absentWorker);
// 意图已送达才让命令动手：runner 死在这次取消之后，不存在「抢先退出」的解释。
writeFileSync(absentSentinel, "go", { mode: 0o600 });
await pumpUntil(
  absentWorker,
  () => {
    const current = cancellationOf(absent.executionId);
    return current !== null && current.state !== "requested" && current.state !== "delivered";
  },
  "absent runner cancel settle",
);
const absentView = view(absent.executionId, nextHolder);
const absentCancel = cancellationOf(absent.executionId)!;
assert.equal(
  durableResults.has(absent.executionId),
  false,
  "runner 缺席时磁盘上不应有 result.json",
);
assert.equal(absentView.state, "unknown");
assert.equal(absentView.recoveryReason, "child-exited-without-result");
assert.equal(absentView.failureReason, "worker_lost");
assert.equal(absentCancel.state, "failed");
assert.equal(absentCancel.failureReason, "exit_not_observed");
assert.equal(absentCancel.exitedAt, null, "没有 result 时不得写「观察到退出」的时间");
pass(
  "R4 反证：runner 缺席的退出停在 unknown:child-exited-without-result，取消是 failed:exit_not_observed 且没有退出时间",
);

console.log(`execution-accept-fixes-2: PASS (${checks.length} checks)`);
rmSync(stateDirectory, { recursive: true, force: true });
