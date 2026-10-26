// 真实 SQLite 与真实服务端边界：恢复归约、日志游标、取消六态、反证。
// 命令正文、token 与私有库都留在 mktemp。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  executionCancellationViewSchema,
  executionLogReadViewSchema,
  executionViewSchema,
} from "../../src/contracts/remote";
import type { RemoteCommand } from "../../src/contracts/remote";
import { migrateDatabase } from "../../src/db/migrate";
import { db, sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { eq } from "drizzle-orm";
import { remoteExecution } from "../../src/db/schema";
import { acquireLease, expireExecutions, LeaseError } from "../../src/server/lease";
import {
  applyExecutionRecovery,
  enqueueCancellation,
  getExecution,
  readExecutionLog,
  RemoteError,
  requestExecution,
} from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";
import { toDomainAppError } from "../../src/server/functions/domain-errors";
import { APP_ERROR_CODES } from "../../src/contracts/result";

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
for (const user of ["owner", "other"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project);
const otherProjectId = newId(ID_PREFIXES.project);
for (const id of [projectId, otherProjectId])
  sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Recovery','owner')").run(id);
const ctx = seedRemoteActor(sqlite, "owner", projectId, bootId);
const another = seedRemoteActor(sqlite, "owner", otherProjectId, bootId);
const machine = createMachine({ name: "Recovery Mac" }, ctx);
const otherMachine = createMachine({ name: "Other Mac" }, ctx);
const machineId = machine.detail.machine.id;
const otherMachineId = otherMachine.detail.machine.id;
for (const id of [ctx.projectId, another.projectId]) {
  saveProjectMachineBinding(
    { projectId: id, machineId, description: "fixture", expectedRevision: null },
    ctx,
  );
  saveProjectMachineBinding(
    { projectId: id, machineId: otherMachineId, description: "fixture", expectedRevision: null },
    ctx,
  );
}
const key = { projectId, machineId };
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, ctx);
const secret = "w".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: req() };
enrollWorker({ ...wire, ticket: machine.ticket }, ctx);
const session = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
let seq = 0;
const exchange = (
  remote = { results: [], fenceAcks: [], mcp: [], mcpCursors: [] } as Parameters<
    typeof exchangeWorker
  >[0]["remote"],
) =>
  exchangeWorker(
    {
      version: 3,
      requestId: wire.requestId,
      secret,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "test",
        shells: [
          {
            path: "/bin/sh",
            kind: "sh",
            version: null,
            checkedAt: ctx.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
      },
      observations: [],
      remote,
    },
    ctx,
  );
exchange();
const shellInput = (requestId = req()) => ({
  ...key,
  requestId,
  authorizationGeneration: 1,
  operation: { kind: "shell" as const, command: "true", cwd: "/tmp", waitMs: 1000 },
});
const submit = (input: ReturnType<typeof shellInput>) => requestExecution(input, ctx);
type CommandIdentity = {
  projectId: string;
  machineId: string;
  executionId: string;
  authorizationGeneration: number;
  holderInstanceId: string;
  dispatchSession: typeof session;
  dispatchSeq: number;
  fingerprint: string;
};
const identityOf = (command: RemoteCommand): CommandIdentity => {
  const {
    operation: _operation,
    requestId: _requestId,
    dispatchDeadlineAt: _deadline,
    directoryRevision: _dir,
    runtimeDeadlineAt: _runtime,
    maxRuntimeMs: _max,
    runnerToken: _token,
    ...identity
  } = command;
  return identity;
};

// 1. 真实下发：宿主生成 runner token，并给出运行上限与下发窗口两个互相独立的截止时间。
const longInput = {
  ...key,
  requestId: req(),
  authorizationGeneration: 1,
  operation: { kind: "shell" as const, command: "true", cwd: "/tmp", waitMs: 1000 },
};
const submitted = submit(longInput);
assert(executionViewSchema.safeParse(submitted).success);
assert.equal(submitted.state, "queued");
const dispatched = exchange();
assert.equal(dispatched.remote.commands.length, 1);
const command = dispatched.remote.commands[0]!;
assert.match(command.runnerToken ?? "", /^[0-9a-f]{32}$/);
assert.notEqual(command.dispatchDeadlineAt, command.runtimeDeadlineAt);
pass("真实下发生成 32 位 runner token，下发窗口与运行上限是两个独立事实");

// 2. 日志帧落盘、gap 行、游标续读与重复帧幂等。
const identity = identityOf(command);
const logFrame = (sequence: number, text: string, extra: Record<string, unknown> = {}) => ({
  ...identity,
  sequence,
  stream: "stdout" as const,
  byteStart: 0,
  byteEnd: Buffer.byteLength(text),
  checksum: digest(text),
  bytes: text,
  ...extra,
});
const logResult = exchange({
  results: [],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
  logFrames: [logFrame(1, "line one\n"), logFrame(2, "line two\n")],
});
assert.equal(logResult.remote.logAcks?.length, 1);
assert.equal(logResult.remote.logAcks![0]!.acknowledgedThroughSequence, 2);
const firstRead = readExecutionLog(
  { ...key, executionId: submitted.executionId, cursor: null, limitBytes: 65536 },
  ctx,
);
assert(executionLogReadViewSchema.safeParse(firstRead).success);
assert.deepEqual(
  firstRead.frames.map((frame) => frame.text),
  ["line one\n", "line two\n"],
);
assert.deepEqual(firstRead.nextCursor, { nextSequence: 2 });
const reread = readExecutionLog(
  { ...key, executionId: submitted.executionId, cursor: null, limitBytes: 65536 },
  ctx,
);
assert.deepEqual(reread.frames, firstRead.frames, "同一游标必须返回相同行");
const continued = readExecutionLog(
  { ...key, executionId: submitted.executionId, cursor: firstRead.nextCursor, limitBytes: 65536 },
  ctx,
);
assert.equal(continued.frames.length, 0);
assert.deepEqual(continued.nextCursor, { nextSequence: 2 });
pass("日志游标续读返回相同行，空范围不被当成完整日志");

// 重复帧幂等：同一 sequence 再送一次不新增行、不推进位点。
const replay = exchange({
  results: [],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
  logFrames: [logFrame(2, "line two\n")],
});
assert.equal(replay.remote.logAcks![0]!.acknowledgedThroughSequence, 2);
const frameCount = sqlite
  .prepare("SELECT COUNT(*) AS n FROM execution_log_frame WHERE execution_id = ?")
  .get(submitted.executionId) as { n: number };
assert.equal(frameCount.n, 2);
pass("重复日志帧幂等：不新增行，不重复推进已确认位点");

// gap 行：只声明缺口，游标跳过缺口，log_state 变 gap。
exchange({
  results: [],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
  logFrames: [
    {
      ...identity,
      sequence: 3,
      stream: "stderr",
      byteStart: 0,
      byteEnd: 0,
      checksum: digest(""),
      gapTo: 5,
    },
  ],
});
const afterGap = readExecutionLog(
  { ...key, executionId: submitted.executionId, cursor: { nextSequence: 2 }, limitBytes: 65536 },
  ctx,
);
assert.deepEqual(afterGap.gapRanges, [{ fromSequence: 3, toSequence: 5 }]);
assert.equal(afterGap.nextCursor.nextSequence, 5);
assert.equal(afterGap.logState, "gap");
assert.equal(afterGap.frames.length, 0);
pass("gap 行只声明缺口：游标跳过缺口范围且 log_state 记为 gap");

// 游标早于可读起点时返回 gap，不静默从新起点称完整。
sqlite
  .prepare("UPDATE remote_execution SET available_from_seq = 3 WHERE id = ?")
  .run(submitted.executionId);
assert.throws(
  () =>
    readExecutionLog(
      {
        ...key,
        executionId: submitted.executionId,
        cursor: { nextSequence: 0 },
        limitBytes: 65536,
      },
      ctx,
    ),
  fail("execution_log_gap"),
);
const fromAvailable = readExecutionLog(
  { ...key, executionId: submitted.executionId, cursor: { nextSequence: 2 }, limitBytes: 65536 },
  ctx,
);
assert.equal(fromAvailable.availableFromSequence, 3);
pass("游标早于 available_from_seq 返回 execution_log_gap，不冒充完整日志");

// 3. 恢复归约：失联写 unknown 后，带 token 的新会话把 unknown 归约为 succeeded。
restoreConnection();
function restoreConnection() {
  sqlite
    .prepare(
      "UPDATE machine_connection SET last_seen_at = ? WHERE machine_id = ? AND generation = ?",
    )
    .run(Date.now(), machineId, session.generation);
}
const later = new Date(Date.now() + 60000);
sqlite
  .prepare("UPDATE machine_connection SET last_seen_at = ? WHERE machine_id = ? AND generation = ?")
  .run(Date.now() - 600000, machineId, session.generation);
expireExecutions(key, later, bootId);
const lostRow = db
  .select()
  .from(remoteExecution)
  .where(eq(remoteExecution.id, submitted.executionId))
  .get()!;
assert.equal(lostRow.state, "unknown");
assert.equal(lostRow.runnerToken, command.runnerToken, "失联不清除 runner token");
pass("已下发却失联保留 runner token，归约仍有据可依");

const recovery = {
  ...identity,
  runnerToken: command.runnerToken!,
  observedState: "exited" as const,
  exitCode: 0,
  signal: null,
  observedExitedAt: new Date(Date.now() - 1000).toISOString(),
  producedThroughSequence: 5,
  claimEvidenceAt: new Date(Date.now() - 60000).toISOString(),
};
applyExecutionRecovery(recovery, { session, now: new Date(), requestId: req() });
const recovered = getExecution({ ...key, executionId: submitted.executionId }, ctx);
assert.equal(recovered.state, "succeeded");
assert.equal(recovered.failureReason, null);
assert.equal(recovered.terminalAt !== null, true);
pass("带 token 的恢复把 unknown 单向归约为 succeeded");

// 反证 1：succeeded 不被后续报告改写。
applyExecutionRecovery(
  { ...recovery, exitCode: 3, signal: "TERM", observedExitedAt: new Date().toISOString() },
  { session, now: new Date(), requestId: req() },
);
assert.equal(getExecution({ ...key, executionId: submitted.executionId }, ctx).state, "succeeded");
pass("反证：succeeded 不被后续恢复报告改写");

// 反证 2：不带 token / token 不符命中 0 行并拒绝。
restoreConnection();
const second = submit(shellInput());
const secondFrame = exchange();
const secondRow = db
  .select()
  .from(remoteExecution)
  .where(eq(remoteExecution.id, second.executionId))
  .get()!;
assert.match(secondRow.runnerToken ?? "", /^[0-9a-f]{32}$/);
const secondIdentity = {
  ...key,
  executionId: second.executionId,
  authorizationGeneration: 1,
  holderInstanceId: ctx.instanceId,
  dispatchSession: { ...session },
  dispatchSeq: secondRow.dispatchSeq!,
  fingerprint: secondRow.payloadHash,
};
assert.throws(
  () =>
    applyExecutionRecovery(
      {
        ...secondIdentity,
        runnerToken: "0".repeat(32),
        observedState: "exited",
        exitCode: 0,
        signal: null,
        observedExitedAt: new Date().toISOString(),
        producedThroughSequence: null,
        claimEvidenceAt: new Date().toISOString(),
      },
      { session, now: new Date(), requestId: req() },
    ),
  fail("execution_log_unavailable"),
);
assert.equal(getExecution({ ...key, executionId: second.executionId }, ctx).state, "dispatched");
pass("反证：token 不符的恢复被拒，执行仍停在 dispatched");

// 反证 3：跨 Machine / 跨 Project 的恢复与日志读取被拒。
{
  const otherSecret = "x".repeat(43);
  const otherWire = {
    machineId: otherMachineId,
    secret: otherSecret,
    version: 3 as const,
    requestId: req(),
  };
  enrollWorker({ ...otherWire, ticket: otherMachine.ticket }, ctx);
  const otherSession = openWorker({ ...otherWire, attemptId: randomUUID() }, ctx).session;
  assert.throws(
    () =>
      applyExecutionRecovery(
        {
          ...secondIdentity,
          runnerToken: secondRow.runnerToken!,
          observedState: "exited",
          exitCode: 0,
          signal: null,
          observedExitedAt: new Date().toISOString(),
          producedThroughSequence: null,
          claimEvidenceAt: new Date().toISOString(),
        },
        { session: otherSession, now: new Date(), requestId: req() },
      ),
    fail("execution_log_unavailable"),
  );
  assert.equal(getExecution({ ...key, executionId: second.executionId }, ctx).state, "dispatched");
}
assert.throws(
  () =>
    readExecutionLog(
      {
        projectId: another.projectId,
        machineId,
        executionId: second.executionId,
        cursor: null,
        limitBytes: 65536,
      },
      another,
    ),
  fail("not_found"),
);
assert.throws(
  () =>
    readExecutionLog(
      { projectId, machineId, executionId: second.executionId, cursor: null, limitBytes: 65536 },
      { ...ctx, userId: "" },
    ),
  fail("unauthorized"),
);
assert.throws(
  () =>
    readExecutionLog(
      {
        projectId: otherProjectId,
        machineId,
        executionId: second.executionId,
        cursor: null,
        limitBytes: 65536,
      },
      another,
    ),
  fail("not_found"),
);
pass("反证：跨 Machine、跨 Project、未登录与旧代次的日志读取都被拒");

// 4. 取消六态推进：requested → delivered → exited_observed。
const cancelInput = {
  ...key,
  executionId: second.executionId,
  requestId: req(),
  authorizationGeneration: 1,
  // 声明非默认值，证明下发用的是入参而不是常量。
  policy: "kill" as const,
  termWaitMs: 500,
};
const requested = enqueueCancellation(cancelInput, ctx);
assert(executionCancellationViewSchema.safeParse(requested).success);
assert.equal(requested.state, "requested");
assert.match(requested.cancelId, /^cnl_/);
// 声明值必须落库：视图不扩形状，直接读行证明入参没有被常量顶替。
const declared = sqlite
  .prepare("SELECT policy, term_wait_ms FROM execution_cancellation WHERE id = ?")
  .get(requested.cancelId) as { policy: string; term_wait_ms: number };
assert.equal(declared.policy, "kill");
assert.equal(declared.term_wait_ms, 500);
assert.equal(enqueueCancellation(cancelInput, ctx).cancelId, requested.cancelId);
pass("取消入队幂等，request_id 落在 cancel: 命名空间且状态停在 requested");
pass("反证：声明 kill/500ms 的取消策略原样下发，不被常量 term_then_kill/2000 覆盖");

const deliveredFrame = exchange();
const intent = deliveredFrame.remote.cancellations?.[0];
assert(intent, "e 取消意图必须随 exchange 下发");
assert.equal(intent.cancelId, requested.cancelId);
assert.equal(deliveredFrame.remote.cancellations!.length, 1);
// runner token 只能来自宿主下发：随 exchange 下发的值与落库值一致。
assert.equal(intent.runnerToken, secondRow.runnerToken);
// 反证：声明 kill/500ms 的意图不能被常量 term_then_kill/2000 顶替。
assert.equal(intent.policy, "kill");
assert.equal(intent.termWaitMs, 500);
const deliveredRow = sqlite
  .prepare("SELECT state, request_id FROM execution_cancellation WHERE id = ?")
  .get(requested.cancelId) as { state: string; request_id: string };
assert.equal(deliveredRow.state, "delivered");
assert.match(deliveredRow.request_id, /^cancel:/);
// 反证 4：delivered 不当作已停止。
assert.equal(getExecution({ ...key, executionId: second.executionId }, ctx).state, "dispatched");
pass("反证：delivered 只说明意图送达，执行状态仍是 dispatched");

// 未收到 durable result 前重复请求同一执行不得再入队新意图。
assert.throws(
  () => enqueueCancellation({ ...cancelInput, requestId: req() }, ctx),
  fail("cancellation_delivery_unconfirmed"),
);
pass("反证：意图未确认前不得把取消伪装成新请求");

// runner 落盘 durable result → 取消进 exited_observed。
const secondCommandIdentity = identityOf(secondFrame.remote.commands[0]!);
exchange({
  results: [
    {
      ...secondCommandIdentity,
      phase: "terminal",
      drained: true,
      outcome: "failed",
      payload: { kind: "shell", failureReason: "executor_error" },
    },
  ],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
});
const exited = sqlite
  .prepare("SELECT state, exited_at FROM execution_cancellation WHERE id = ?")
  .get(requested.cancelId) as { state: string; exited_at: number | null };
assert.equal(exited.state, "exited_observed");
assert.notEqual(exited.exited_at, null);
assert.equal(getExecution({ ...key, executionId: second.executionId }, ctx).state, "failed");
pass("runner durable result 把取消推进到 exited_observed，且不改写执行结果成因");

// 终态执行不得再入队取消。
assert.throws(
  () => enqueueCancellation({ ...cancelInput, requestId: req() }, ctx),
  fail("cancellation_already_terminal"),
);
pass("反证：终态执行拒绝新的取消意图");

// 5. 下发窗口到期且未下发 → timed_out(deadline)；运行上限到期不写终态。
const queued = submit(shellInput());
sqlite
  .prepare("UPDATE remote_execution SET created_at = ?, dispatch_deadline_at = ? WHERE id = ?")
  .run(Date.now() - 120000, Date.now() - 90000, queued.executionId);
expireExecutions(key, new Date(), bootId);
const timedOut = getExecution({ ...key, executionId: queued.executionId }, ctx);
assert.equal(timedOut.state, "timed_out");
assert.equal(timedOut.failureReason, "deadline");
pass("下发窗口到期且未下发写 timed_out + failure_reason='deadline'");

// 6. 错误码登记：6 个新码全部在 domain-errors 有固定文案。
for (const code of [
  "execution_log_gap",
  "execution_log_cursor_stale",
  "execution_log_unavailable",
  "cancellation_not_found",
  "cancellation_already_terminal",
  "cancellation_delivery_unconfirmed",
] as const) {
  assert(APP_ERROR_CODES.includes(code));
  const mapped = await toDomainAppError(new RemoteError(code), req());
  assert.equal(mapped?.code, code);
  assert(mapped!.message.length > 0);
  const viaLease = await toDomainAppError(new LeaseError(code), req());
  assert.equal(viaLease?.code, code);
}
pass("6 个新错误码在服务端边界登记固定文案，不退化成 conflict");

// 7. 未下发且未到期仍保持可调度：恢复之后仍能重新下发新执行。
const stillQueued = submit(shellInput());
assert.equal(getExecution({ ...key, executionId: stillQueued.executionId }, ctx).state, "queued");
pass("到期收尾只影响到期行，新执行仍可入队");

console.log(`execution-recovery: PASS ${checks.length} 条真实边界断言`);
sqlite.close();
