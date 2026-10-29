// I-P4d 归属/移出/通知的补充验收：伪造投递事实、跨代次 fence 反证、同机双 Project、
// 通知收件集合与重启一致性、挂起投影的重启一致、真实边界的新错误码。
// 私有库、会话 cookie 与命令正文都留在 mktemp。
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { RemoteCommand, RemoteReport } from "../../src/contracts/remote";
import { WORKER_STALE_AFTER_MS } from "../../src/contracts/worker";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  agentProfile,
  agentRun,
  executionCancellation,
  leaseAuthorization,
  leaseMutation,
  machineLease,
  projectMachine,
  projectMachineMembership,
  remoteExecution,
  runResourceNotice,
} from "../../src/db/schema";
import type { MachineContext } from "../../src/domain/machine";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { auth } from "../../src/lib/auth";
import { acquireLease, forceReclaimLease, getLease, handoffLease } from "../../src/server/lease";
import {
  detachMachine,
  liveMembership,
  membershipActive,
  membershipViewFor,
  openInitialMembership,
  pendingFactFor,
} from "../../src/server/membership";
import {
  insertRevokeNotice,
  markRunNoticeDelivered,
  noticeDeliveryText,
  pendingRunNotices,
} from "../../src/server/notices";
import {
  cancelExecution,
  enqueueCancellation,
  getExecution,
  listProjectExecutions,
  readExecutionLog,
  requestExecution,
} from "../../src/server/remote";
import {
  cancelExecutionBoundary,
  getExecutionBoundary,
  listProjectExecutionsBoundary,
  readExecutionLogBoundary,
} from "../../src/server/functions/remote";
import {
  detachMachineBoundary,
  membershipViewBoundary,
} from "../../src/server/functions/membership";
import { remoteAgentResponse } from "../../src/server/remote-agent-gateway";
import { runtimeSnapshot, startRuntime } from "../../src/server/runtime";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

const scenario = process.argv[2];
const stateFile = process.env.P4D_STATE_FILE;
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const pass = (name: string) => console.log(`PASS ${name}`);

if (!scenario) throw new Error("需要 scenario 参数");

migrateDatabase();
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT OR IGNORE INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
for (const user of ["owner", "other"])
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project);
const projectB = newId(ID_PREFIXES.project);
sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'IntA','owner')").run(projectId);
sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'IntB','owner')").run(projectB);

/** 夹具时钟从真实时间起走：租约收据与执行行都带真实写入时间。 */
let clock = Date.now();
const tick = (ms = 1000) => new Date((clock += ms));
function human(userId = "owner", now = new Date()): MachineContext {
  return { userId, requestId: req(), bootId, now };
}
function actor(project = projectId) {
  const seeded = seedRemoteActor(sqlite, "owner", project, bootId);
  seeded.now = new Date();
  return seeded;
}
let machineSequence = 0;
/** 一台真实 Machine + 绑定 + epoch=1 的 active membership。 */
function machineFor(options: { bindProjectB?: boolean; owner?: string } = {}) {
  machineSequence += 1;
  const owner = options.owner ?? "owner";
  const created = createMachine(
    { name: `Int Machine ${machineSequence}` },
    human(owner, new Date()),
  );
  const machineId = created.detail.machine.id;
  for (const project of options.bindProjectB ? [projectId, projectB] : [projectId]) {
    saveProjectMachineBinding(
      { projectId: project, machineId, description: "p4d int fixture", expectedRevision: null },
      human(owner, new Date()),
    );
    openInitialMembership(db, { projectId: project, machineId, now: new Date() });
  }
  return { machineId, ticket: created.ticket, owner };
}
function keyOf(project: string, machineId: string) {
  return { projectId: project, machineId };
}
/** 一台真 Worker：enroll + open，exchange 失败不推进 seq（网关要求连续 seq）。 */
function worker(project: string, machineId: string, ticket: string, ctx: MachineContext) {
  const secret = randomBytes(32).toString("base64url");
  const wire = { version: 3 as const, requestId: req(), machineId, secret };
  enrollWorker({ ...wire, ticket }, ctx);
  const session = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
  let seq = 0;
  function exchange(
    results: RemoteReport[] = [],
    fenceAcks: Parameters<typeof exchangeWorker>[0]["remote"]["fenceAcks"] = [],
  ) {
    const next = seq + 1;
    const output = exchangeWorker(
      {
        version: 3,
        requestId: req(),
        secret,
        session,
        seq: next,
        mode: "normal",
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "p4d-int",
          shells: [],
          remoteOperations: ["file_write", "file_read"],
        },
        observations: [],
        remote: { results, fenceAcks, mcp: [], mcpCursors: [] },
      },
      // 每次 exchange 都取当前时钟：宿主不会用种子时刻给送达时间盖章。
      { ...ctx, now: new Date() },
    );
    seq = next;
    return output;
  }
  return { session, secret, exchange, project, machineId };
}
function terminalReport(command: RemoteCommand, outcome: "succeeded" | "failed" = "succeeded") {
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
  return {
    ...identity,
    phase: "terminal" as const,
    drained: true,
    outcome,
    payload:
      outcome === "succeeded"
        ? { kind: command.operation.kind, bytesWritten: 4 }
        : { kind: command.operation.kind, failureReason: "executor_error" as const },
  } as unknown as RemoteReport;
}
const writeOperation = {
  kind: "file_write" as const,
  path: "/tmp/p4d-int-authority-never-run",
  content: "fact",
  mode: "overwrite" as const,
};
function submit(project: string, machineId: string, holder: ReturnType<typeof actor>, extra = {}) {
  return requestExecution(
    {
      projectId: project,
      machineId,
      requestId: req(),
      authorizationGeneration: 1,
      operation: writeOperation,
      ...extra,
    },
    holder,
  );
}
function receipt(key: { projectId: string; machineId: string }, ctx: MachineContext, extra = {}) {
  const epoch =
    db
      .select()
      .from(projectMachineMembership)
      .where(
        and(
          eq(projectMachineMembership.projectId, key.projectId),
          eq(projectMachineMembership.machineId, key.machineId),
        ),
      )
      .orderBy(projectMachineMembership.epoch)
      .all()
      .at(-1)?.epoch ?? 1;
  const binding = db
    .select()
    .from(projectMachine)
    .where(
      and(eq(projectMachine.projectId, key.projectId), eq(projectMachine.machineId, key.machineId)),
    )
    .get()!;
  const lease = db
    .select()
    .from(machineLease)
    .where(
      and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
    )
    .get();
  return {
    ...key,
    requestId: ctx.requestId,
    expectedEpoch: epoch,
    expectedRevision: binding.revision,
    expectedGeneration: lease?.generation ?? 0,
    confirm: true as const,
    ...extra,
  };
}
const noticeRows = (
  project: string,
  machineId: string,
): (typeof runResourceNotice.$inferSelect)[] =>
  db
    .select()
    .from(runResourceNotice)
    .where(
      and(eq(runResourceNotice.projectId, project), eq(runResourceNotice.machineId, machineId)),
    )
    .all();
const membershipRows = (key: { projectId: string; machineId: string }) =>
  db
    .select()
    .from(projectMachineMembership)
    .where(
      and(
        eq(projectMachineMembership.projectId, key.projectId),
        eq(projectMachineMembership.machineId, key.machineId),
      ),
    )
    .orderBy(projectMachineMembership.epoch)
    .all();
const readState = () => JSON.parse(readFileSync(stateFile!, "utf8")) as Record<string, string>;
const writeState = (value: Record<string, unknown>) =>
  writeFileSync(stateFile!, JSON.stringify(value, null, 2));

if (scenario === "forged") {
  // ——— 迟到的物理事实：伪造身份逐项被拒，真实身份跨持有人变化仍是真事实。
  const machine = machineFor();
  const key = keyOf(projectId, machine.machineId);
  const holder = actor();
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
  const workerA = worker(projectId, machine.machineId, machine.ticket, holder);
  workerA.exchange();
  const execution = submit(projectId, machine.machineId, holder);
  const command = workerA.exchange().remote.commands[0]!;
  const base = terminalReport(command);
  const forged: Array<[string, Partial<RemoteReport>]> = [
    ["project", { projectId: projectB }],
    ["machine", { machineId: newId(ID_PREFIXES.machine) }],
    ["holder", { holderInstanceId: newId(ID_PREFIXES.instance) }],
    ["originGeneration", { authorizationGeneration: 2 }],
    ["fingerprint", { fingerprint: "f".repeat(64) }],
    ["session", { dispatchSession: { ...base.dispatchSession, attemptId: randomUUID() } }],
    ["dispatchSeq", { dispatchSeq: base.dispatchSeq + 5 }],
  ];
  for (const [label, patch] of forged) {
    assert.throws(
      () => workerA.exchange([{ ...base, ...patch } as RemoteReport]),
      fail("not_found"),
      `伪造的 ${label} 必须被拒`,
    );
    assert.equal(
      db.select().from(remoteExecution).where(eq(remoteExecution.id, execution.executionId)).get()!
        .state,
      "dispatched",
      `伪造的 ${label} 不能推进执行状态`,
    );
  }
  pass("伪造 project/machine/holder/origin/fingerprint/session/dispatchSeq 全部 not_found 且无写");

  // 合法投递 → succeeded；迟到 running 不覆盖已知终态，异 payload 的迟到终态是冲突。
  workerA.exchange([base]);
  assert.equal(
    getExecution({ ...key, executionId: execution.executionId }, human()).state,
    "succeeded",
  );
  workerA.exchange([{ ...base, phase: "running", drained: false } as RemoteReport]);
  assert.equal(
    getExecution({ ...key, executionId: execution.executionId }, human()).state,
    "succeeded",
    "迟到 running 不覆盖已终态",
  );
  assert.throws(
    () =>
      workerA.exchange([
        {
          ...base,
          outcome: "failed",
          payload: { kind: "file_write", failureReason: "executor_error" },
        } as RemoteReport,
      ]),
    fail("remote_request_conflict"),
  );
  pass("迟到 running 不覆盖终态；同执行异 payload 的迟到终态是 remote_request_conflict");

  // worker_lost 的 unknown 只按真实退出证据升级。
  const lost = submit(projectId, machine.machineId, holder);
  const lostCommand = workerA.exchange().remote.commands[0]!;
  sqlite
    .prepare(
      "UPDATE remote_execution SET state='unknown',failure_reason='worker_lost',terminal_at=? WHERE id=?",
    )
    .run(tick().getTime(), lost.executionId);
  workerA.exchange([terminalReport(lostCommand, "failed")]);
  assert.equal(
    getExecution({ ...key, executionId: lost.executionId }, human()).failureReason,
    "executor_error",
    "worker_lost 的 unknown 被真实退出报告升级",
  );
  pass("state=unknown/failureReason=worker_lost 只被真实退出证据升级");

  // —— free 后到达的合法投递保留真实 outcome（租约不是物理事实的守卫）。
  const freeMachine = machineFor();
  const freeKey = keyOf(projectId, freeMachine.machineId);
  const freeHolder = actor();
  acquireLease(
    { ...freeKey, action: "acquire", requestId: req(), expectedGeneration: 0 },
    freeHolder,
  );
  const freeWorker = worker(projectId, freeMachine.machineId, freeMachine.ticket, freeHolder);
  freeWorker.exchange();
  const freeExecution = submit(projectId, freeMachine.machineId, freeHolder);
  const freeCommand = freeWorker.exchange().remote.commands[0]!;
  sqlite
    .prepare(
      "UPDATE machine_lease SET state='free',holder_instance_id=NULL,generation=generation+1,changed_at=? WHERE project_id=? AND machine_id=?",
    )
    .run(clock, projectId, freeMachine.machineId);
  freeWorker.exchange([terminalReport(freeCommand)]);
  assert.equal(
    getExecution({ ...freeKey, executionId: freeExecution.executionId }, human()).state,
    "succeeded",
    "free 之后到达的合法投递仍是真实 outcome",
  );
  pass("lease=free 后到达的合法投递保留真实 outcome");

  // —— detaching 期间到达的合法投递保留真实 outcome（移出不是物理事实的守卫）。
  const detachMachineFixture = machineFor();
  const detachKey = keyOf(projectId, detachMachineFixture.machineId);
  const detachHolder = actor();
  acquireLease(
    { ...detachKey, action: "acquire", requestId: req(), expectedGeneration: 0 },
    detachHolder,
  );
  const detachWorker = worker(
    projectId,
    detachMachineFixture.machineId,
    detachMachineFixture.ticket,
    detachHolder,
  );
  detachWorker.exchange();
  const detachExecution = submit(projectId, detachMachineFixture.machineId, detachHolder);
  const detachCommand = detachWorker.exchange().remote.commands[0]!;
  const pendingDetach = detachMachine(receipt(detachKey, human()), human());
  assert.equal(pendingDetach.state, "detaching");
  detachWorker.exchange([terminalReport(detachCommand)]);
  assert.equal(
    getExecution({ ...detachKey, executionId: detachExecution.executionId }, human()).state,
    "succeeded",
    "detaching 期间的合法投递仍是真实 outcome",
  );
  assert.equal(membershipRows(detachKey).at(-1)!.state, "removed", "收据完成后移出即时结束");
  pass("detaching 期间到达的合法投递保留真实 outcome");

  // —— 跨代次 fence：接续 origin=g 的在途执行后再交接，pending 门与 fence 输出覆盖它；
  //    同机其他 Project 和 origin 越界的伪造执行不被覆盖。
  const dual = machineFor({ bindProjectB: true });
  const keyP = keyOf(projectId, dual.machineId);
  const keyQ = keyOf(projectB, dual.machineId);
  const holderP = actor();
  const holderQ = actor(projectB);
  acquireLease({ ...keyP, action: "acquire", requestId: req(), expectedGeneration: 0 }, holderP);
  acquireLease({ ...keyQ, action: "acquire", requestId: req(), expectedGeneration: 0 }, holderQ);
  const dualWorker = worker(projectId, dual.machineId, dual.ticket, holderP);
  dualWorker.exchange();
  const inP = submit(projectId, dual.machineId, holderP);
  const inQ = submit(projectB, dual.machineId, holderQ);
  const commands = dualWorker.exchange().remote.commands;
  assert.equal(commands.length, 2, "两个 Project 的执行都要真下发");
  // 伪造 origin 越界的执行：origin=5 高于 fence 上界 3。授权表每个 scope 只有一行当前代次，
  // 复合外键让「origin 越界且没有对应授权」的行根本写不进来。
  const forgedId = newId(ID_PREFIXES.execution);
  const forgedRow = {
    id: forgedId,
    projectId,
    machineId: dual.machineId,
    authorizationGeneration: 5,
    holderInstanceId: holderP.instanceId,
    runId: holderP.runId,
    chatId: holderP.chatId,
    requestId: req(),
    payloadHash: "e".repeat(64),
    operationJson: writeOperation,
    state: "queued" as const,
    createdAt: new Date(),
    dispatchDeadlineAt: new Date(Date.now() + 30000),
  };
  assert.throws(
    () => db.insert(remoteExecution).values(forgedRow).run(),
    /FOREIGN KEY/,
    "origin 越界的执行没有对应授权行，写不进来",
  );
  const forgedAuthorization = {
    projectId,
    machineId: dual.machineId,
    generation: 5,
    holderInstanceId: holderP.instanceId,
    state: "active" as const,
    issuedAt: new Date(),
    reason: "handoff" as const,
  };
  assert.throws(
    () => db.insert(leaseAuthorization).values(forgedAuthorization).run(),
    /UNIQUE/,
    "同一 scope 只能有一条当前授权，越界代次无法伪造",
  );
  // 旧 holder 以 g=1 发起交接 → g=2 fencing，pending 门可读。
  const handoffTarget = actor();
  handoffLease(
    {
      ...keyP,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: handoffTarget.instanceId,
    },
    holderP,
  );
  const fenceView = getLease(keyP, human());
  assert.equal(fenceView.lease.state, "fencing");
  const pendingGate = pendingFactFor(keyP, new Date(), { canForceReclaim: false })!;
  assert.equal(pendingGate.kind, "lease_fencing", "fencing 期间 pending 门仍可读");
  // fence 输出覆盖仍在途的 origin=g 执行，不含同机其他 Project 的执行。
  const fence = dualWorker.exchange().remote.fences[0]!;
  const mutation = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, projectId),
        eq(leaseMutation.machineId, dual.machineId),
        eq(leaseMutation.state, "pending"),
      ),
    )
    .get()!;
  assert.equal(fence.mutationId, mutation.id);
  assert.equal(fence.authorizationGeneration, mutation.expectedGeneration);
  assert.deepEqual(new Set(fence.executionIds), new Set([inP.executionId]));
  pass("fence 输出覆盖 origin=g 的在途执行，不含同机其他 Project 与越界 origin 的伪造行");
  // 伪造 fence ack：带上其他 Project 的执行 → 整笔拒绝，不覆盖该行。
  const qRow = () =>
    db.select().from(remoteExecution).where(eq(remoteExecution.id, inQ.executionId)).get()!;
  assert.throws(
    () =>
      dualWorker.exchange(
        [],
        [
          {
            mutationId: mutation.id,
            projectId,
            machineId: dual.machineId,
            authorizationGeneration: mutation.expectedGeneration,
            dispatchSession: dualWorker.session,
            executionIds: [inP.executionId, inQ.executionId],
          },
        ],
      ),
    fail("not_found"),
  );
  assert.equal(qRow().drainedAt, null, "其他 Project 的执行不被本 Project 的 fence 覆盖");
  // 伪造 fence ack：带上 origin 越界的执行 id → 同样拒绝。
  assert.throws(
    () =>
      dualWorker.exchange(
        [],
        [
          {
            mutationId: mutation.id,
            projectId,
            machineId: dual.machineId,
            authorizationGeneration: mutation.expectedGeneration,
            dispatchSession: dualWorker.session,
            executionIds: [inP.executionId, forgedId],
          },
        ],
      ),
    fail("not_found"),
  );
  assert.equal(
    db.select().from(remoteExecution).where(eq(remoteExecution.id, forgedId)).get(),
    undefined,
    "origin 越界的伪造执行从未存在，也不被覆盖",
  );
  // 合法 ack：只 ack 无退出报告 → unknown/authorization_revoked，不冒充 success 或被拒。
  dualWorker.exchange(
    [],
    [
      {
        mutationId: mutation.id,
        projectId,
        machineId: dual.machineId,
        authorizationGeneration: mutation.expectedGeneration,
        dispatchSession: dualWorker.session,
        executionIds: [inP.executionId],
      },
    ],
  );
  const acked = getExecution({ ...keyP, executionId: inP.executionId }, human());
  assert.equal(acked.state, "unknown");
  assert.equal(acked.failureReason, "authorization_revoked");
  assert.equal(getLease(keyP, human()).lease.generation, 2);
  assert.equal(getLease(keyP, human()).lease.holderInstanceId, handoffTarget.instanceId);
  assert.equal(qRow().drainedAt, null);
  pass("伪造 fence ack 整笔 not_found 且无写；合法 ack 无退出报告得到 unknown");
}

if (scenario === "notices") {
  // —— 收件集合：无执行的旧 holder 收到、活动执行关联 run 覆盖、跨 Project/新 holder/已结束 run 不误投。
  const machine = machineFor();
  const key = keyOf(projectId, machine.machineId);
  const holder = actor();
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
  const holderWorker = worker(projectId, machine.machineId, machine.ticket, holder);
  holderWorker.exchange();
  // 旧 holder 在途执行 + 一个同 Project 但与本次撤权无关的活动 run。
  const inFlight = submit(projectId, machine.machineId, holder);
  holderWorker.exchange();
  const bystander = actor();
  // 同机其他 Project 的 holder run 不能收到本 Project 的通知。
  const qActor = actor(projectB);
  const view = detachMachine(receipt(key, human()), human());
  assert.equal(view.state, "detaching");
  const rows = noticeRows(projectId, machine.machineId);
  assert.deepEqual(
    rows.map((row) => row.runId),
    [holder.runId],
    "旧 holder run 被覆盖，无关的同 Project 活动 run 不误投",
  );
  assert.equal(bystander.runId === holder.runId, false);
  assert.equal(
    rows[0]!.payloadJson.executions.some(
      (execution: { executionId: string }) => execution.executionId === inFlight.executionId,
    ),
    true,
    "通知携带同 scope 在途执行的事实",
  );
  assert.equal(new Set(rows.map((row) => row.causeId)).size, 1, "detach 只有一份根因");
  assert.equal(
    rows.every((row) => row.kind === "machine_removed"),
    true,
  );
  assert.equal(noticeRows(projectB, machine.machineId).length, 0, "跨 Project 不误投");
  assert.equal(qActor.runId === holder.runId, false);
  // 目标新 holder 不收到「你失去资源」。
  const handoffMachine = machineFor();
  const handoffKey = keyOf(projectId, handoffMachine.machineId);
  const source = actor();
  const target = actor();
  acquireLease(
    { ...handoffKey, action: "acquire", requestId: req(), expectedGeneration: 0 },
    source,
  );
  handoffLease(
    {
      ...handoffKey,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: target.instanceId,
    },
    source,
  );
  const handoffNotices = noticeRows(projectId, handoffMachine.machineId);
  assert.deepEqual(
    handoffNotices.map((row) => row.runId),
    [source.runId],
    "只有旧 holder 收到交接通知",
  );
  assert.equal(handoffNotices[0]!.kind, "lease_handed_off");
  // 已结束 run 不误投。
  const doneMachine = machineFor();
  const doneKey = keyOf(projectId, doneMachine.machineId);
  const doneHolder = actor();
  acquireLease(
    { ...doneKey, action: "acquire", requestId: req(), expectedGeneration: 0 },
    doneHolder,
  );
  const doneWorker = worker(projectId, doneMachine.machineId, doneMachine.ticket, doneHolder);
  doneWorker.exchange();
  submit(projectId, doneMachine.machineId, doneHolder);
  doneWorker.exchange();
  sqlite
    .prepare("UPDATE agent_run SET status='aborted',settled_at=? WHERE id=?")
    .run(clock, doneHolder.runId);
  detachMachine(receipt(doneKey, human()), human());
  assert.equal(noticeRows(projectId, doneMachine.machineId).length, 0, "已结束 run 不误投");
  // 事务回滚无 notice。
  const aborted = machineFor();
  const abortedKey = keyOf(projectId, aborted.machineId);
  assert.throws(
    () => detachMachine(receipt(abortedKey, human(), { expectedRevision: 9 }), human()),
    fail("conflict"),
  );
  assert.equal(noticeRows(projectId, aborted.machineId).length, 0, "回滚不写 notice");
  pass("通知收件集合：旧 holder/关联 run 覆盖，跨 Project、新 holder、已结束 run 不误投");

  // 崩溃窗口：投递前重启，pending 仍带同一 noticeId 与同一文本。
  const undelivered = pendingRunNotices({ runId: holder.runId }, human())[0]!;
  assert.equal(undelivered.deliveredAt, null);
  assert.equal(undelivered.id, rows[0]!.id);
  assert.equal(
    markRunNoticeDelivered(rows.find((row) => row.id !== undelivered.id)?.id ?? "none", tick()),
    false,
    "不存在的 noticeId 不标记",
  );
  writeState({
    machineId: machine.machineId,
    linkedRunId: holder.runId,
    noticeId: undelivered.id,
    noticeText: noticeDeliveryText(undelivered),
  });
  pass("通知 outbox：交付后不再拉取，未交付事实待重启后仍存在");
}

if (scenario === "notices-restart") {
  const state = readState();
  const pending = pendingRunNotices({ runId: state.linkedRunId }, human());
  assert.equal(pending.length, 1, "重启后未投递的通知仍在 outbox");
  assert.equal(pending[0]!.id, state.noticeId, "重启不换 noticeId");
  assert.equal(noticeDeliveryText(pending[0]!), state.noticeText, "重启后文本逐字一致");
  assert.equal(pending[0]!.deliveredAt, null);
  assert.equal(markRunNoticeDelivered(pending[0]!.id, tick()), true, "重启后仍能标记交付");
  assert.equal(pendingRunNotices({ runId: state.linkedRunId }, human()).length, 0);
  pass("提交后崩溃重启：pending 通知仍在、noticeId 与文本不变、交付后不重复");
}

if (scenario === "pending-restart-setup") {
  // fencing 挂起 + 投影边界；重启后再读一次同样的投影。
  const machine = machineFor();
  const key = keyOf(projectId, machine.machineId);
  const holder = actor();
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
  const workerA = worker(projectId, machine.machineId, machine.ticket, holder);
  workerA.exchange();
  const execution = submit(projectId, machine.machineId, holder);
  workerA.exchange();
  const handoff = handoffLease(
    {
      ...key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: actor().instanceId,
    },
    holder,
  );
  assert.equal(handoff.state, "pending");
  const mutation = db
    .select()
    .from(leaseMutation)
    .where(eq(leaseMutation.id, handoff.mutationId))
    .get()!;
  writeState({
    projectId,
    machineId: machine.machineId,
    executionId: execution.executionId,
    since: mutation.createdAt.toISOString(),
  });
  const early = pendingFactFor(key, new Date(mutation.createdAt.getTime() + 14999), {
    canForceReclaim: true,
  })!;
  assert.equal(early.elapsedMs, WORKER_STALE_AFTER_MS - 1);
  assert.equal(early.overdue, false);
  const boundary = pendingFactFor(key, new Date(mutation.createdAt.getTime() + 15000), {
    canForceReclaim: true,
  })!;
  assert.equal(boundary.elapsedMs, WORKER_STALE_AFTER_MS);
  assert.equal(boundary.overdue, true);
  pass("挂起投影 14999/15000 毫秒边界");
}

if (scenario === "pending-restart-read") {
  const state = readState();
  const key = keyOf(state.projectId, state.machineId);
  const since = new Date(state.since);
  const projection = () =>
    pendingFactFor(key, new Date(since.getTime() + 600000), { canForceReclaim: true });
  const first = projection();
  // 五秒刷新：同一时刻的重复读取给出逐字段相同的投影。
  assert.deepEqual(projection(), first);
  assert.equal(first!.kind, "lease_fencing");
  assert.equal(first!.since, state.since);
  // 时间过去不改变 receipt、membership、授权与执行终态，也不自动 free。
  assert.equal(getLease(key, human()).lease.state, "fencing");
  assert.equal(getLease(key, human()).lease.generation, 1, "fencing 期间代次不上跳");
  const authorization = db
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, state.projectId),
        eq(leaseAuthorization.machineId, state.machineId),
      ),
    )
    .all();
  const latestAuthorization = [...authorization]
    .sort((a, b) => a.generation - b.generation)
    .at(-1)!;
  assert.equal(latestAuthorization.generation, 1, "授权代次不被时间推进");
  assert.equal(latestAuthorization.state, "draining", "授权不被时间推进成 free 或新代次");
  assert.equal(membershipRows(key).at(-1)!.state, "active", "membership 不被时间改写");
  const execution = db
    .select()
    .from(remoteExecution)
    .where(eq(remoteExecution.id, state.executionId))
    .get()!;
  assert.equal(execution.state, "draining", "fencing 把在途执行放进 draining");
  assert.equal(execution.terminalAt, null, "没有终态被时间伪造");
  assert.equal(execution.drainedAt, null);
  assert.equal(getExecution({ ...key, executionId: state.executionId }, human()).state, "draining");
  pass("重启后投影一致；时间过去不改 receipt/membership/授权/终态，不自动 free");
}

if (scenario === "pq") {
  // 同机双 Project：移出 P 后 Q 的绑定/授权/执行逐列不变，Q 继续真实执行。
  const machine = machineFor({ bindProjectB: true });
  const keyP = keyOf(projectId, machine.machineId);
  const keyQ = keyOf(projectB, machine.machineId);
  const holderP = actor();
  const holderQ = actor(projectB);
  acquireLease({ ...keyP, action: "acquire", requestId: req(), expectedGeneration: 0 }, holderP);
  acquireLease({ ...keyQ, action: "acquire", requestId: req(), expectedGeneration: 0 }, holderQ);
  const dualWorker = worker(projectId, machine.machineId, machine.ticket, holderP);
  dualWorker.exchange();
  const executionP = submit(projectId, machine.machineId, holderP);
  const commandP = dualWorker.exchange().remote.commands[0]!;
  assert.equal(commandP.executionId, executionP.executionId);
  const executionQ = submit(projectB, machine.machineId, holderQ);
  const commandQ = dualWorker
    .exchange()
    .remote.commands.find(
      (command: RemoteCommand) => command.executionId === executionQ.executionId,
    )!;
  dualWorker.exchange([terminalReport(commandQ)]);
  const snapshot = () => ({
    binding: db
      .select()
      .from(projectMachine)
      .where(
        and(
          eq(projectMachine.projectId, projectB),
          eq(projectMachine.machineId, machine.machineId),
        ),
      )
      .get(),
    membership: membershipRows(keyQ),
    lease: db
      .select()
      .from(machineLease)
      .where(
        and(eq(machineLease.projectId, projectB), eq(machineLease.machineId, machine.machineId)),
      )
      .get(),
    authorization: db
      .select()
      .from(leaseAuthorization)
      .where(
        and(
          eq(leaseAuthorization.projectId, projectB),
          eq(leaseAuthorization.machineId, machine.machineId),
        ),
      )
      .all(),
    executions: db
      .select()
      .from(remoteExecution)
      .where(
        and(
          eq(remoteExecution.projectId, projectB),
          eq(remoteExecution.machineId, machine.machineId),
        ),
      )
      .all(),
  });
  const before = snapshot();
  // 移出 P：在途 → detaching，可见；强制收回 → removed，不再出现在活动选择器。
  const detaching = detachMachine(receipt(keyP, human()), human());
  assert.equal(detaching.state, "detaching");
  assert.equal(liveMembership(projectId).get(machine.machineId)?.state, "detaching");
  forceReclaimLease(
    {
      ...keyP,
      action: "force_reclaim",
      mutationId: detaching.removalMutationId!,
      expectedGeneration: 1,
      confirm: true,
    },
    human(),
  );
  assert.equal(membershipViewFor(keyP, tick())!.state, "removed");
  assert.equal(membershipActive(projectId, machine.machineId), false);
  assert.equal(liveMembership(projectId).get(machine.machineId)?.state, "removed");
  const after = snapshot();
  assert.deepEqual(after, before, "Q 的绑定、membership、租约、授权、执行逐列不变");
  assert.equal(membershipActive(projectB, machine.machineId), true);
  // Q 继续真实执行。
  const nextQ = submit(projectB, machine.machineId, holderQ, { authorizationGeneration: 1 });
  const nextQCommand = dualWorker
    .exchange()
    .remote.commands.find((command: RemoteCommand) => command.executionId === nextQ.executionId)!;
  dualWorker.exchange([terminalReport(nextQCommand)]);
  assert.equal(
    getExecution({ ...keyQ, executionId: nextQ.executionId }, human()).state,
    "succeeded",
  );
  // P 的 Agent 执行读是 lease_not_holder；提交等操作仍按 membership_removed。
  for (const read of [
    () => getExecution({ ...keyP, executionId: executionP.executionId }, holderP),
    () =>
      readExecutionLog(
        { ...keyP, executionId: executionP.executionId, cursor: null, limitBytes: 4096 },
        holderP,
      ),
  ])
    assert.throws(read, fail("lease_not_holder"));
  assert.throws(() => submit(projectId, machine.machineId, holderP), fail("membership_removed"));
  // P 的 Human 执行、日志与租约 receipt 历史仍可读。
  assert.equal(
    getExecution({ ...keyP, executionId: executionP.executionId }, human()).executionId,
    executionP.executionId,
  );
  assert.equal(
    readExecutionLog(
      { ...keyP, executionId: executionP.executionId, cursor: null, limitBytes: 4096 },
      human(),
    ).executionId,
    executionP.executionId,
  );
  assert.equal(
    listProjectExecutions({ projectId }, human()).some(
      (row) => row.executionId === executionP.executionId,
    ),
    true,
  );
  assert.equal(
    getLease({ ...keyP, mutationId: detaching.removalMutationId! }, human()).mutation?.action,
    "reclaim",
  );
  pass("同机 P/Q：移出 P 后 Q 逐列不变并继续执行，P Agent 拒、P Human 历史可读");
}

if (scenario === "http") {
  await startRuntime();
  const runtime = runtimeSnapshot();
  const boot = runtime.bootId!;
  // ——— Agent 侧真实 HTTP：真实 grant + 真实 Request/Response，不降级成 conflict/internal。
  const machine = machineFor();
  const key = keyOf(projectId, machine.machineId);
  const holderA = actor();
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holderA);
  const workerA = worker(projectId, machine.machineId, machine.ticket, holderA);
  workerA.exchange();
  const execution = submit(projectId, machine.machineId, holderA);
  workerA.exchange();
  const grantActor = seedRemoteActor(sqlite, "owner", projectId, bootId, false);
  const { issueRemoteToolGrant } = await import("../../src/server/remote-agent-gateway");
  const grant = issueRemoteToolGrant(grantActor.runId, { pid: process.pid } as never, {
    bootId: boot,
    requestId: req(),
    now: new Date(),
  });
  const call = async (
    body: unknown,
    bearer: string | null = grant.secret,
  ): Promise<{ code?: string; status: number; ok: boolean; data?: unknown }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-sprout-request-id": req(),
    };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const response = await remoteAgentResponse(
      new Request("http://localhost:3000/api/remote/agent", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: string };
    };
    return {
      ok: payload.ok,
      data: payload.data,
      code: payload.error?.code,
      status: response.status,
    };
  };
  const submitCall = (extra: Record<string, unknown> = {}) => ({
    version: 2 as const,
    call: {
      type: "execution_submit" as const,
      input: {
        ...key,
        requestId: req(),
        authorizationGeneration: 1,
        operation: writeOperation,
        ...extra,
      },
    },
  });
  const anonymous = await call(submitCall(), null);
  assert.equal(anonymous.code, "remote_grant_invalid");
  assert.equal(anonymous.status, 401);
  const forgedGrant = await call(submitCall(), randomBytes(32).toString("base64url"));
  assert.equal(forgedGrant.code, "remote_grant_invalid");
  // 非 holder 派发。
  const notHolder = await call(submitCall());
  assert.equal(notHolder.code, "lease_not_holder");
  // 跨 Project 输入。
  const crossProject = await call(submitCall({ projectId: projectB }));
  assert.equal(crossProject.code, "not_found");
  // 旧代次读取与取消。
  const staleRead = await call({
    version: 2,
    call: {
      type: "execution_get",
      input: { ...key, executionId: execution.executionId },
    },
  });
  assert.equal(staleRead.code, "lease_not_holder", "非 holder 的读是 lease_not_holder");
  // fencing/draining 期间的写被拒 lease_fencing。
  handoffLease(
    {
      ...key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: grantActor.instanceId,
    },
    holderA,
  );
  const fencingCancel = await call({
    version: 2,
    call: {
      type: "execution_cancel",
      input: {
        ...key,
        executionId: execution.executionId,
        requestId: req(),
        authorizationGeneration: 1,
        policy: "kill",
        termWaitMs: 1,
      },
    },
  });
  assert.equal(fencingCancel.code, "lease_fencing");
  // 完成交接：fence ack 把租约推进到 g=2 并交给 grant 的 instance。
  const fence = workerA.exchange().remote.fences[0]!;
  workerA.exchange(
    [],
    [
      {
        mutationId: fence.mutationId,
        projectId,
        machineId: machine.machineId,
        authorizationGeneration: fence.authorizationGeneration,
        dispatchSession: workerA.session,
        executionIds: fence.executionIds,
      },
    ],
  );
  // 目标 holder 的旧代次请求被拒 lease_stale_generation。
  const staleGeneration = await call(submitCall({ authorizationGeneration: 1 }));
  assert.equal(staleGeneration.code, "lease_stale_generation");
  // 移出后 Agent 执行读是 lease_not_holder（membership_removed 留给 submit 等操作）。
  const removedMembership = detachMachine(receipt(key, human()), human());
  assert.equal(removedMembership.state, "removed");
  const removedAgentRead = await call({
    version: 2,
    call: {
      type: "execution_get",
      input: { ...key, executionId: execution.executionId },
    },
  });
  assert.equal(removedAgentRead.code, "lease_not_holder");
  for (const result of [notHolder, crossProject, fencingCancel, staleGeneration, removedAgentRead])
    assert.equal(
      ["conflict", "internal"].includes(result.code ?? ""),
      false,
      "新错误码不降级成 conflict/internal",
    );
  pass(
    "Agent 真实 HTTP：未登录/伪造 grant、非 holder、跨 Project、旧代次、fencing、removed 原码透出",
  );

  // ——— Human 侧真实登录 + 真实 Fn 边界。
  const signUp = async (tag: string) => {
    const result = await auth.api.signUpEmail({
      body: {
        email: `${tag}-${Date.now()}@example.test`,
        password: "fixture-password-1",
        name: tag,
      },
      returnHeaders: true,
    });
    const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    return { headers: new Headers({ cookie }), userId: result.response.user.id };
  };
  const owner = await signUp("p4d-int-owner");
  const stranger = await signUp("p4d-int-stranger");
  const ownershipCtx: MachineContext = {
    userId: owner.userId,
    requestId: req(),
    bootId: boot,
    now: new Date(),
  };
  const ownProject = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Boundary',?)")
    .run(ownProject, owner.userId);
  const created = createMachine({ name: "Boundary Mac" }, ownershipCtx);
  const ownMachineId = created.detail.machine.id;
  saveProjectMachineBinding(
    {
      projectId: ownProject,
      machineId: ownMachineId,
      description: "boundary",
      expectedRevision: null,
    },
    ownershipCtx,
  );
  openInitialMembership(db, { projectId: ownProject, machineId: ownMachineId, now: new Date() });
  const ownKey = keyOf(ownProject, ownMachineId);
  const ownHolder = seedRemoteActor(sqlite, owner.userId, ownProject, boot);
  acquireLease(
    { ...ownKey, action: "acquire", requestId: req(), expectedGeneration: 0 },
    ownHolder,
  );
  const ownWorker = worker(ownProject, ownMachineId, created.ticket, ownHolder);
  ownWorker.exchange();
  const ownExecution = requestExecution(
    {
      ...ownKey,
      requestId: req(),
      authorizationGeneration: 1,
      operation: writeOperation,
    },
    ownHolder,
  );
  const ownCommand = ownWorker.exchange().remote.commands[0]!;
  // 未登录。
  const anonymousRead = await getExecutionBoundary(
    { ...ownKey, executionId: ownExecution.executionId },
    new Headers(),
    req(),
  );
  assert.equal(anonymousRead.ok, false);
  assert.equal((anonymousRead as { error: { code: string } }).error.code, "unauthorized");
  // 跨用户。
  const strangerRead = await getExecutionBoundary(
    { ...ownKey, executionId: ownExecution.executionId },
    stranger.headers,
    req(),
  );
  assert.equal((strangerRead as { error: { code: string } }).error.code, "not_found");
  const strangerLog = await readExecutionLogBoundary(
    { ...ownKey, executionId: ownExecution.executionId, cursor: null, limitBytes: 4096 },
    stranger.headers,
    req(),
  );
  assert.equal((strangerLog as { error: { code: string } }).error.code, "not_found");
  const strangerList = await listProjectExecutionsBoundary(
    { projectId: ownProject },
    stranger.headers,
    req(),
  );
  assert.equal((strangerList as { error: { code: string } }).error.code, "not_found");
  // 跨 Project：同一用户把执行 id 挂到自己的另一个 Project 上。
  const crossProjectKey = { projectId, machineId: machine.machineId };
  const crossProjectRead = await getExecutionBoundary(
    { ...crossProjectKey, executionId: ownExecution.executionId },
    owner.headers,
    req(),
  );
  assert.equal((crossProjectRead as { error: { code: string } }).error.code, "not_found");
  // 移出 pending：detach 重放同 requestId 同 epoch 收据；异 payload 是 remote_request_conflict。
  const detachGeneration = getLease(ownKey, human(owner.userId)).lease.generation;
  const detachRequest = {
    projectId: ownProject,
    machineId: ownMachineId,
    requestId: req(),
    expectedEpoch: 1,
    expectedRevision: 1,
    expectedGeneration: detachGeneration,
    confirm: true as const,
  };
  const detaching = await detachMachineBoundary(detachRequest, owner.headers, req());
  assert.equal(detaching.ok, true, JSON.stringify(detaching));
  const detachingAgain = await detachMachineBoundary(detachRequest, owner.headers, req());
  assert.equal(detachingAgain.ok, true);
  assert.equal(
    (detachingAgain as { data: { requestedAt: string } }).data.requestedAt,
    (detaching as { data: { requestedAt: string } }).data.requestedAt,
    "同 detach 请求返回同收据",
  );
  const conflicting = await detachMachineBoundary(
    { ...detachRequest, expectedRevision: 2 },
    owner.headers,
    req(),
  );
  assert.equal((conflicting as { error: { code: string } }).error.code, "remote_request_conflict");
  const pendingDetach = await detachMachineBoundary(
    { ...detachRequest, requestId: req() },
    owner.headers,
    req(),
  );
  assert.equal((pendingDetach as { error: { code: string } }).error.code, "detach_pending");
  // fencing 期间 Human 取消不再假装已入队。
  const fencingHuman = await cancelExecutionBoundary(
    { executionId: ownExecution.executionId, requestId: req() },
    owner.headers,
    req(),
  );
  assert.equal(
    (fencingHuman as { error: { code: string } }).error.code,
    "detach_pending",
    "移出 pending 期间 Human 取消原码透出，不假装已入队",
  );
  // Human history 在 detaching 仍可达。
  const detachingView = await membershipViewBoundary(
    { projectId: ownProject, machineId: ownMachineId },
    owner.headers,
    req(),
  );
  assert.equal(detachingView.ok, true);
  assert.equal((detachingView as { data: { state: string } }).data.state, "detaching");
  const detachingHistory = await getExecutionBoundary(
    { ...ownKey, executionId: ownExecution.executionId },
    owner.headers,
    req(),
  );
  assert.equal(detachingHistory.ok, true, "detaching 期间 Human 执行历史仍可读");
  // 交付完最后一条在途执行后，撤销收据在同一事务里把移出推进到 removed。
  ownWorker.exchange([terminalReport(ownCommand)]);
  assert.equal(
    db
      .select()
      .from(projectMachineMembership)
      .where(
        and(
          eq(projectMachineMembership.projectId, ownProject),
          eq(projectMachineMembership.machineId, ownMachineId),
        ),
      )
      .get()!.state,
    "removed",
    "撤销收据完成后移出即时结束",
  );
  const removedRead = await getExecutionBoundary(
    { ...ownKey, executionId: ownExecution.executionId },
    owner.headers,
    req(),
  );
  assert.equal(removedRead.ok, true, "removed 后 Human 执行历史仍可读");
  const removedCancel = await cancelExecutionBoundary(
    { executionId: ownExecution.executionId, requestId: req() },
    owner.headers,
    req(),
  );
  assert.equal((removedCancel as { error: { code: string } }).error.code, "membership_removed");
  const removedView = await membershipViewBoundary(
    { projectId: ownProject, machineId: ownMachineId },
    owner.headers,
    req(),
  );
  assert.equal(removedView.ok, true);
  assert.equal((removedView as { data: { state: string } }).data.state, "removed");
  assert.equal(
    getLease(ownKey, human(owner.userId)).lease.generation,
    detachGeneration + 1,
    "移出不把租约代次归零",
  );
  for (const result of [
    anonymousRead,
    strangerRead,
    strangerLog,
    strangerList,
    crossProjectRead,
    fencingHuman,
    conflicting,
    pendingDetach,
    removedCancel,
  ] as Array<{ error?: { code: string } }>) {
    const code = result.error?.code ?? "ok";
    assert.equal(
      ["conflict", "internal"].includes(code),
      false,
      `${code} 不能降级成 conflict/internal`,
    );
  }
  pass("Human 真实登录 Fn：未登录、跨用户、跨 Project、detach pending/重放冲突、removed 原码透出");
}

if (scenario === "intent") {
  const machine = machineFor();
  const key = keyOf(projectId, machine.machineId);
  const holder = actor();
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
  const workerA = worker(projectId, machine.machineId, machine.ticket, holder);
  const cancel = (executionId: string, generation: number, ctx = holder, requestId = req()) =>
    enqueueCancellation(
      {
        ...key,
        executionId,
        requestId,
        authorizationGeneration: generation,
        policy: "kill",
        termWaitMs: 1,
      },
      ctx,
    );
  workerA.exchange();
  const first = submit(projectId, machine.machineId, holder);
  const firstCommand = workerA.exchange().remote.commands[0]!;
  // 同 requestId 重试只返回同一条取消事实。
  const retryRequest = req();
  const intent = cancel(first.executionId, 1, holder, retryRequest);
  const replay = cancel(first.executionId, 1, holder, retryRequest);
  assert.equal(replay.cancelId, intent.cancelId);
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) AS n FROM execution_cancellation").get() as { n: number }).n,
    1,
    "重试不新增取消行",
  );
  assert.equal(workerA.exchange().remote.cancellations[0]!.cancelId, intent.cancelId);
  workerA.exchange([terminalReport(firstCommand)]);
  // 换到下一代次后，旧代次的取消意图不再投递。
  const next = actor();
  handoffLease(
    {
      ...key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: next.instanceId,
    },
    holder,
  );
  // 没有未 drained 的执行时，交接在下一次 exchange 里直接完成。
  assert.equal(workerA.exchange().remote.fences.length, 0);
  assert.equal(getLease(key, human()).lease.generation, 2);
  assert.equal(getLease(key, human()).lease.holderInstanceId, next.instanceId);
  const second = submit(projectId, machine.machineId, next, { authorizationGeneration: 2 });
  const secondCommand = workerA.exchange().remote.commands[0]!;
  assert.equal(secondCommand.executionId, second.executionId);
  const third = submit(projectId, machine.machineId, next, { authorizationGeneration: 2 });
  assert.equal(workerA.exchange().remote.commands[0]!.executionId, third.executionId);
  const staleIntent = cancel(second.executionId, 2, next);
  assert.equal(staleIntent.state, "requested");
  // 再交接一次：代次推进到 3 之前就发起，旧意图在换代次后不投递。
  handoffLease(
    {
      ...key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 2,
      targetInstanceId: actor().instanceId,
    },
    next,
  );
  const advanced = workerA.exchange().remote.cancellations ?? [];
  assert.equal(
    advanced.some((item: { cancelId: string }) => item.cancelId === staleIntent.cancelId),
    false,
    "代次推进后旧取消不投递",
  );
  const staleRow = db
    .select()
    .from(executionCancellation)
    .where(eq(executionCancellation.id, staleIntent.cancelId))
    .get()!;
  assert.equal(staleRow.state, "requested");
  // 模拟 cutover 快照：当前权威已是 g=3/A，而执行 origin 仍是 g=2/B。
  sqlite
    .prepare(
      "UPDATE lease_authorization SET state='revoked',revoked_at=? WHERE project_id=? AND machine_id=? AND generation=2",
    )
    .run(tick().getTime(), projectId, machine.machineId);
  db.insert(leaseAuthorization)
    .values({
      projectId,
      machineId: machine.machineId,
      generation: 3,
      holderInstanceId: holder.instanceId,
      state: "active",
      reason: "reclaim",
      issuedAt: tick(),
    })
    .run();
  sqlite
    .prepare(
      "UPDATE machine_lease SET state='held',holder_instance_id=?,generation=3,changed_at=? WHERE project_id=? AND machine_id=?",
    )
    .run(holder.instanceId, tick().getTime(), projectId, machine.machineId);
  // Human 不因 origin holder 不同被误拒：取消按当前权威归属，执行仍记 origin。
  const humanCancel = cancelExecution(
    { executionId: third.executionId, requestId: req() },
    human(),
  );
  assert.equal(humanCancel.state, "requested");
  const humanRow = sqlite
    .prepare(
      "SELECT authorization_generation,holder_instance_id,actor_kind FROM execution_cancellation WHERE id=?",
    )
    .get(humanCancel.cancelId) as {
    authorization_generation: number;
    holder_instance_id: string;
    actor_kind: string;
  };
  assert.equal(humanRow.actor_kind, "human");
  assert.equal(humanRow.authorization_generation, 3);
  assert.equal(humanRow.holder_instance_id, holder.instanceId);
  const executionRow = db
    .select()
    .from(remoteExecution)
    .where(eq(remoteExecution.id, third.executionId))
    .get()!;
  assert.equal(executionRow.authorizationGeneration, 2, "执行 origin 代次不被取消改写");
  assert.equal(executionRow.holderInstanceId, next.instanceId, "执行 origin holder 不被改写");
  pass("取消：重试幂等、换代次后旧意图不投递、Human 按当前权威而非 origin holder 归属");
}

if (scenario === "steer") {
  await startRuntime();
  // 一条 queued run + 一条已落库但未投递的撤权通知，注入假 process 直接跑真实 executeRun。
  const ownerId = "owner";
  const projectId2 = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Steer','owner')")
    .run(projectId2);
  const profileId = newId(ID_PREFIXES.agentProfile);
  const chatId = newId(ID_PREFIXES.chat);
  const instanceId = newId(ID_PREFIXES.instance);
  const runId = `run_${randomUUID()}`;
  const messageId = newId(ID_PREFIXES.message);
  sqlite
    .prepare("INSERT INTO agent_profile(id,name,created_by) VALUES (?,'Steer fixture',?)")
    .run(profileId, ownerId);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?,?,'dm','human',?,?)",
    )
    .run(chatId, projectId2, ownerId, ownerId);
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
    .run(chatId, profileId);
  sqlite
    .prepare("INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES (?,?,?)")
    .run(projectId2, profileId, ownerId);
  sqlite
    .prepare("INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)")
    .run(instanceId, profileId, chatId, projectId2);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,queued_at,session_id) VALUES (?,?,?,?,?,'queued',?,?)",
    )
    .run(runId, instanceId, chatId, projectId2, req(), Date.now(), randomUUID());
  sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,created_at) VALUES (?,?,'human',?,?,?)",
    )
    .run(messageId, chatId, ownerId, "跑一下", Date.now());
  sqlite
    .prepare("INSERT INTO agent_run_input(message_id,run_id) VALUES (?,?)")
    .run(messageId, runId);
  const machine = machineFor();
  saveProjectMachineBinding(
    {
      projectId: projectId2,
      machineId: machine.machineId,
      description: "steer",
      expectedRevision: null,
    },
    human(),
  );
  openInitialMembership(db, {
    projectId: projectId2,
    machineId: machine.machineId,
    now: new Date(),
  });
  const key = keyOf(projectId2, machine.machineId);
  insertRevokeNotice(db, {
    key,
    kind: "lease_released",
    causeId: newId(ID_PREFIXES.leaseMutation),
    generation: 1,
    revocation: "confirmed",
    executions: [],
    holderInstanceId: instanceId,
    now: new Date(),
  });
  const { executeRun } = await import("../../src/server/pi-host/run");
  const { Effect } = await import("effect");
  const makeProcess = (steerFailures: number) => {
    let noticeCalls = 0;
    return {
      calls: () => noticeCalls,
      pid: process.pid,
      onDelivered: undefined as ((messageId: string) => void) | undefined,
      onRejected: undefined as ((messageId: string, reason: string) => void) | undefined,
      onDispose: () => {},
      close: async () => {},
      open: async (payload: { sessionId: string }) => ({
        sessionId: payload.sessionId,
        agentDir: "/tmp",
        cwd: "/tmp",
        runnerPath: "/tmp",
      }),
      prompt: async (id: string) => {
        setTimeout(() => {
          const self = fake as { onDelivered?: (messageId: string) => void };
          self.onDelivered?.(id);
        }, 50);
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { text: "完成", stopReason: "stop" };
      },
      steer: (id: string) => {
        if (!id.startsWith("notice:")) return;
        noticeCalls += 1;
        if (noticeCalls <= steerFailures) throw new Error("steer boom");
      },
    };
    // eslint-disable-next-line no-unreachable
  };
  const work = db.select().from(agentRun).where(eq(agentRun.id, runId)).get()!;
  const fake = makeProcess(1);
  const profile = db.select().from(agentProfile).where(eq(agentProfile.id, profileId)).get()!;
  await Effect.runPromise(
    executeRun({ run: work, profile, ownerId }, fake as never, { isStopping: () => false }),
  );
  const notice = pendingRunNotices({ runId }, { userId: ownerId, requestId: req() });
  assert.equal(notice.length, 0, "成功 steer 后通知被标记已投递");
  const noticeRow = db
    .select()
    .from(runResourceNotice)
    .where(eq(runResourceNotice.runId, runId))
    .get()!;
  assert.notEqual(noticeRow.deliveredAt, null);
  assert.equal(fake.calls(), 2, "失败的 steer 不标记已投递，下一轮重试一次");
  const settled = db.select().from(agentRun).where(eq(agentRun.id, runId)).get()!;
  assert.equal(settled.status, "completed", "通知投递异常不把 run 拉倒");
  pass("通知投递：steer 异常不标 delivered 且不停 run，成功后不重复拉取");
}

sqlite.close();
