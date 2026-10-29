// 真实 SQLite + 真实领域边界：独立验收 F1/F2/N2 的修复与反证。
// 私有库、runner token 与命令正文都留在 mktemp，不进日志。
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
import { sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { acquireLease, handoffLease, LeaseError } from "../../src/server/lease";
import type { AgentRemoteContext } from "../../src/server/lease";
import {
  cancellationConfirmWindowMs,
  enqueueCancellation,
  getExecution,
  readExecutionLog,
  RemoteError,
  requestExecution,
} from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import type { MachineContext } from "../../src/domain/machine";
import { toDomainAppError } from "../../src/server/functions/domain-errors";
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
const foreignProjectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Acceptance','owner')")
  .run(projectId);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Stranger','stranger')")
  .run(foreignProjectId);

// 同一 Project 上的两个分身：先 holder，另一个是同 Project 的活动非 holder。
const holder = seedRemoteActor(sqlite, "owner", projectId, bootId);
const sibling = seedRemoteActor(sqlite, "owner", projectId, bootId);
const foreign = seedRemoteActor(sqlite, "stranger", foreignProjectId, bootId);
const human = { userId: "owner", bootId, now: new Date(), requestId: newId(ID_PREFIXES.request) };
const machine = createMachine({ name: "Acceptance Mac" }, holder);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "fixture", expectedRevision: null },
  holder,
);
const key = { projectId, machineId };
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const rowCount = () =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM execution_cancellation").get() as { n: number }).n;
const diagnosticCount = () =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM diagnostic_event").get() as { n: number }).n;

acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
const secret = "a".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: req() };
enrollWorker({ ...wire, ticket: machine.ticket }, holder);
const session = openWorker({ ...wire, attemptId: randomUUID() }, holder).session;
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
            checkedAt: holder.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["shell"],
      },
      observations: [],
      remote,
    },
    { ...holder, now: new Date() },
  );
exchange();
const submit = (generation: number) =>
  requestExecution(
    {
      ...key,
      requestId: req(),
      authorizationGeneration: generation,
      operation: { kind: "shell" as const, command: "true", cwd: "/tmp", waitMs: 1000 },
    },
    holder,
  );
const identityOf = (command: RemoteCommand) => {
  const {
    operation: _operation,
    requestId: _requestId,
    dispatchDeadlineAt: _deadline,
    directoryRevision: _directory,
    runtimeDeadlineAt: _runtime,
    maxRuntimeMs: _max,
    runnerToken: _token,
    ...identity
  } = command;
  return identity;
};
const logFrame = (identity: ReturnType<typeof identityOf>, sequence: number, text: string) => ({
  ...identity,
  sequence,
  stream: "stdout" as const,
  byteStart: 0,
  byteEnd: Buffer.byteLength(text),
  checksum: digest(text),
  bytes: text,
});
const readLog = (
  executionId: string,
  ctx: AgentRemoteContext | MachineContext,
  limitBytes = 65536,
) => readExecutionLog({ ...key, executionId, cursor: null, limitBytes }, ctx);

// 1. holder 下发并产出一帧日志：holder 能读执行与帧。
const owned = submit(1);
const command = exchange().remote.commands[0]!;
const identity = identityOf(command);
const frameResult = exchange({
  results: [],
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
  logFrames: [logFrame(identity, 1, "known prefix\n"), logFrame(identity, 2, "second line\n")],
});
assert.equal(frameResult.remote.logAcks?.length, 1);
const holderView = getExecution({ ...key, executionId: owned.executionId }, holder);
assert(executionViewSchema.safeParse(holderView).success);
const holderLog = readLog(owned.executionId, holder);
assert(executionLogReadViewSchema.safeParse(holderLog).success);
assert.deepEqual(
  holderLog.frames.map((frame) => frame.text),
  ["known prefix\n", "second line\n"],
);
pass("F1 正证：holder 读到自己的执行与已落盘的两帧日志");

// 2. 同 Project 的活动分身（非 holder）读执行与日志都被拒，且不返回帧。
assert.throws(
  () => getExecution({ ...key, executionId: owned.executionId }, sibling),
  fail("lease_not_holder"),
);
assert.throws(() => readLog(owned.executionId, sibling), fail("lease_not_holder"));
pass("F1 反证：同 Project 非 holder 分身读执行与日志都是 lease_not_holder，没有帧泄露");

// 3. 人类路径不受影响：Project 创建者仍能读本项目在本 Machine 上的执行与日志。
const humanView = getExecution({ ...key, executionId: owned.executionId }, human);
assert.equal(humanView.executionId, owned.executionId);
assert.deepEqual(
  readLog(owned.executionId, human).frames.map((frame) => frame.text),
  ["known prefix\n", "second line\n"],
);
pass("F1 正证：人类（Project 创建者）读取执行与日志不受 holder 规则影响");

// 4. 其它身份边界不回归：跨 Project 的分身仍是 not_found，不探测 holder。
assert.throws(
  () =>
    getExecution(
      { projectId: foreign.projectId, machineId, executionId: owned.executionId },
      foreign,
    ),
  fail("not_found"),
);
pass("F1 反证：跨 Project 读取仍报 not_found，不泄露执行是否存在");

// 5. 租约交接给新 holder：旧 holder 与新一代 holder 都读不到旧执行，人类仍可读。
//    交接走真实两阶段：先 fencing，Worker 交回旧执行的终态报告后代次 +1。
const handed = handoffLease(
  {
    ...key,
    action: "handoff",
    requestId: req(),
    expectedGeneration: 1,
    targetInstanceId: sibling.instanceId,
  },
  holder,
);
assert.equal(handed.state, "pending");
// fencing 窗口内旧 holder 仍可读自己已派发的执行；这时授权在 draining，不能冒充已交接。
assert.equal(
  getExecution({ ...key, executionId: owned.executionId }, holder).executionId,
  owned.executionId,
);
exchange({
  results: [
    {
      ...identity,
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
  fenceAcks: [],
  mcp: [],
  mcpCursors: [],
});
const afterHandoff = sqlite
  .prepare(
    "SELECT generation, state, holder_instance_id FROM machine_lease WHERE project_id = ? AND machine_id = ?",
  )
  .get(projectId, machineId) as {
  generation: number;
  state: string;
  holder_instance_id: string | null;
};
assert.equal(afterHandoff.generation, 2);
assert.equal(afterHandoff.state, "held");
assert.equal(afterHandoff.holder_instance_id, sibling.instanceId);
assert.throws(
  () => getExecution({ ...key, executionId: owned.executionId }, holder),
  fail("lease_not_holder"),
);
assert.throws(() => readLog(owned.executionId, holder), fail("lease_not_holder"));
// 交接完成后新 holder 接续既有执行的读与管理，旧 holder 立即失效。
assert.equal(
  getExecution({ ...key, executionId: owned.executionId }, sibling).executionId,
  owned.executionId,
);
assert.equal(
  getExecution({ ...key, executionId: owned.executionId }, human).executionId,
  owned.executionId,
);
pass("F1 正证：fencing 内旧 holder 可读；交接后旧 holder 被拒，新 holder 接续取读同一执行");

// 6. 新 holder 在新代次上的执行照常可读：拒绝是因为不成立，不是一律拒绝。
const siblingExecution = requestExecution(
  {
    ...key,
    requestId: req(),
    authorizationGeneration: 2,
    operation: { kind: "shell" as const, command: "true", cwd: "/tmp", waitMs: 1000 },
  },
  sibling,
);
exchange();
assert.equal(
  getExecution({ ...key, executionId: siblingExecution.executionId }, sibling).executionId,
  siblingExecution.executionId,
);
assert.equal(readLog(siblingExecution.executionId, sibling).logState, "none");
pass("F1 正证：新 holder 在 held 代次上读取自己的执行与日志仍然成功");

// 7. F2：调用方声明的授权代次必须就是执行与当前租约的代次。
const beforeReject = rowCount();
const beforeDiagnostics = diagnosticCount();
const staleLow = {
  ...key,
  executionId: siblingExecution.executionId,
  requestId: req(),
  policy: "term_then_kill" as const,
  termWaitMs: 10000,
};
assert.throws(
  () => enqueueCancellation({ ...staleLow, authorizationGeneration: 1 }, sibling),
  fail("lease_stale_generation"),
);
assert.throws(
  () => enqueueCancellation({ ...staleLow, requestId: req(), authorizationGeneration: 3 }, sibling),
  fail("lease_stale_generation"),
);
assert.equal(rowCount(), beforeReject);
assert.equal(diagnosticCount(), beforeDiagnostics);
pass("F2 反证：代次 1 与 3 的取消都是 lease_stale_generation，不写取消行、不写诊断事件");

// 8. 代次相等时正常入队；幂等重试返回同一取消；同一 requestId 换执行仍冲突。
const cancelInput = { ...staleLow, authorizationGeneration: 2 };
const requested = enqueueCancellation(cancelInput, sibling);
assert(executionCancellationViewSchema.safeParse(requested).success);
assert.equal(requested.state, "requested");
assert.equal(enqueueCancellation(cancelInput, sibling).cancelId, requested.cancelId);
const declared = sqlite
  .prepare("SELECT policy, term_wait_ms FROM execution_cancellation WHERE id = ?")
  .get(requested.cancelId) as { policy: string; term_wait_ms: number };
assert.equal(declared.policy, "term_then_kill");
assert.equal(declared.term_wait_ms, 10000);
assert.equal(rowCount(), beforeReject + 1);
pass("F2 正证：代次相等的取消入队且声明 10 秒宽限原样落库，重试返回同一取消");

const another = requestExecution(
  {
    ...key,
    requestId: req(),
    authorizationGeneration: 2,
    operation: { kind: "shell" as const, command: "true", cwd: "/tmp", waitMs: 1000 },
  },
  sibling,
);
exchange();
assert.throws(
  () => enqueueCancellation({ ...cancelInput, executionId: another.executionId }, sibling),
  fail("remote_request_conflict"),
);
pass("F2 反证：同一 requestId 换执行仍报 remote_request_conflict");

// 9. N2：limitBytes 是软预算，比单帧还小时仍返回一帧并推进游标。
const tiny = readLog(owned.executionId, human, 1);
assert(executionLogReadViewSchema.safeParse(tiny).success);
assert.equal(tiny.frames.length, 1);
assert.equal(tiny.frames[0]!.sequence, 1);
assert.equal(tiny.frames[0]!.text, "known prefix\n");
assert.equal(tiny.nextCursor.nextSequence, 1);
const afterTiny = readExecutionLog(
  { ...key, executionId: owned.executionId, cursor: tiny.nextCursor, limitBytes: 1 },
  human,
);
assert.equal(afterTiny.frames.length, 1);
assert.equal(afterTiny.frames[0]!.sequence, 2);
assert.equal(afterTiny.nextCursor.nextSequence, 2);
pass("N2 正证：limitBytes=1 仍返回一帧并让游标从 #1 推进到 #2");

// 10. F3：确认窗口从本次取消的 termWaitMs 派生，覆盖 TERM 宽限 + 退出观测 + 余量。
const shortWindow = cancellationConfirmWindowMs(2000);
const maxWindow = cancellationConfirmWindowMs(10000);
assert.equal(maxWindow, 20000);
assert.ok(maxWindow > 15000, "旧常量 15 秒不足以覆盖 10 秒宽限 + 退出观测");
assert.ok(maxWindow >= 10000 + 5000);
assert.ok(maxWindow > shortWindow);
pass("F3 正证：确认窗口随 termWaitMs 派生（10 秒宽限 → 20 秒），不再固定 15 秒");

// 11. 错误码仍按域错误透出，不退回 conflict。
for (const [error, code] of [
  [new LeaseError("lease_not_holder"), "lease_not_holder"],
  [new RemoteError("lease_stale_generation"), "lease_stale_generation"],
] as const) {
  const mapped = await toDomainAppError(error, req());
  assert.equal(mapped?.code, code);
  assert.equal(mapped!.message.length > 0, true);
}
pass("F1/F2 错误码在 domain-errors 边界仍按原码透出，不退回 conflict");

console.log(`execution-accept-fixes: PASS (${checks.length} checks)`);
