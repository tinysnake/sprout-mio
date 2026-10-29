import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { WORKER_STALE_AFTER_MS } from "../../src/contracts/worker";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  leaseMutation,
  machineLease,
  projectMachine,
  projectMachineMembership,
  remoteExecution,
  runResourceNotice,
} from "../../src/db/schema";
import type { MachineContext } from "../../src/domain/machine";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import {
  acquireLease,
  completeLeaseMutation,
  forceReclaimLease,
  getLease,
  handoffLease,
  reclaimLease,
  releaseLease,
} from "../../src/server/lease";
import {
  detachMachine,
  liveMembership,
  membershipActive,
  membershipViewFor,
  onLeaseMutationCompleted,
  openInitialMembership,
  pendingFactFor,
  rejoinProjectMachine,
} from "../../src/server/membership";
import {
  insertRevokeNotice,
  markRunNoticeDelivered,
  noticeDeliveryText,
  pendingRunNotices,
} from "../../src/server/notices";
import { getExecution, listProjectExecutions, requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";
import type { AgentRemoteContext } from "../../src/server/lease";

migrateDatabase();
const scenario = process.argv[2];
const bootId = newId(ID_PREFIXES.boot);
const req = () => newId(ID_PREFIXES.request);
// 夹具时钟从当前真实时间起走：租约收据与执行行都带真实写入时间，回拨会让 CHECK 失败。
let clock = Date.now();
const tick = (ms = 1000) => new Date((clock += ms));

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
const projectB = newId(ID_PREFIXES.project);
for (const id of [projectId, projectB])
  sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Removal','owner')").run(id);

function human(userId = "owner", now = tick()): MachineContext {
  return { userId, requestId: req(), bootId, now };
}
function actor(project = projectId): AgentRemoteContext {
  return seedRemoteActor(sqlite, "owner", project, bootId);
}
const fails = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const validation = (error: unknown) =>
  error instanceof Error && (error.name === "ZodError" || "issues" in error);

let machineSequence = 0;
function machineWithMembership(
  options: { bindProjectB?: boolean; leaseHolder?: AgentRemoteContext } = {},
) {
  machineSequence += 1;
  const owner = human();
  // ticket 过期判定用真实时钟，避免固定夹具时钟把凭据当成已过期。
  const settled = createMachine(
    { name: `Removal Mac ${machineSequence}` },
    { ...owner, now: new Date() },
  );
  const machineId = settled.detail.machine.id;
  const ticket = settled.ticket;
  saveProjectMachineBinding(
    { projectId, machineId, description: "removal fixture", expectedRevision: null },
    owner,
  );
  openInitialMembership(db, { projectId, machineId, now: owner.now });
  if (options.bindProjectB) {
    saveProjectMachineBinding(
      { projectId: projectB, machineId, description: "other project", expectedRevision: null },
      owner,
    );
    openInitialMembership(db, { projectId: projectB, machineId, now: owner.now });
  }
  const key = { projectId, machineId };
  if (options.leaseHolder) {
    acquireLease(
      { ...key, action: "acquire", requestId: req(), expectedGeneration: 0 },
      options.leaseHolder,
    );
  }
  return { machineId, key, owner, ticket };
}

function workerConnection(ctxForEnroll: MachineContext, machineId: string, ticket: string) {
  const secret = randomBytes(32).toString("base64url");
  const wire = { version: 3 as const, requestId: req(), machineId, secret };
  enrollWorker({ ...wire, ticket }, ctxForEnroll);
  const session = openWorker({ ...wire, attemptId: randomUUID() }, ctxForEnroll).session;
  return { session, secret };
}

function dispatchExecution(
  holder: AgentRemoteContext,
  key: { projectId: string; machineId: string },
  ticket: string,
) {
  const { session, secret } = workerConnection(holder, key.machineId, ticket);
  let seq = 0;
  const exchange = () =>
    exchangeWorker(
      {
        version: 3,
        requestId: req(),
        secret,
        session,
        seq: ++seq,
        mode: "normal",
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "removal-test",
          shells: [],
          remoteOperations: ["file_read"],
        },
        observations: [],
        remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
      },
      holder,
    );
  exchange();
  const execution = requestExecution(
    {
      ...key,
      requestId: req(),
      authorizationGeneration: 1,
      operation: { kind: "file_read", path: "/tmp/removal-fixture-never-read", maxBytes: 64 },
    },
    holder,
  );
  exchange();
  return execution.executionId;
}

function membershipRowCount(key: { projectId: string; machineId: string }) {
  return db
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
}

function noticeRows(key: { projectId: string; machineId: string }) {
  return db
    .select()
    .from(runResourceNotice)
    .where(
      and(
        eq(runResourceNotice.projectId, key.projectId),
        eq(runResourceNotice.machineId, key.machineId),
      ),
    )
    .all();
}

function completeReceipt(key: { projectId: string; machineId: string }, now: Date) {
  return sqlite
    .transaction(() => {
      completeLeaseMutation(key, now);
      const member = db
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
        .at(-1)!;
      const receipt = member.removalMutationId
        ? db
            .select()
            .from(leaseMutation)
            .where(eq(leaseMutation.id, member.removalMutationId))
            .get()
        : undefined;
      return receipt ? onLeaseMutationCompleted(db, receipt) : false;
    })
    .immediate();
}

function detachInput(
  key: { projectId: string; machineId: string },
  ctx: MachineContext,
  extra = {},
) {
  const epoch = membershipRowCount(key).at(-1)?.epoch ?? 1;
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

function detach(key: { projectId: string; machineId: string }, ctx: MachineContext, extra = {}) {
  return detachMachine(detachInput(key, ctx, extra), ctx);
}

if (scenario === "detach") {
  // 1. 无租约：直接 removed，不建 lease mutation。
  const free = machineWithMembership();
  const wrongRevision = human();
  assert.throws(
    () => detach(free.key, wrongRevision, { expectedRevision: 99 }),
    fails("conflict"),
    "CAS 错必须无写",
  );
  assert.equal(membershipRowCount(free.key)[0]?.state, "active");
  assert.equal(noticeRows(free.key).length, 0);
  const invalid = human();
  assert.throws(
    () =>
      detachMachine(
        {
          ...free.key,
          requestId: invalid.requestId,
          expectedEpoch: 1,
          expectedRevision: 1,
          expectedGeneration: 0,
          confirm: false,
        } as never,
        invalid,
      ),
    validation,
    "confirm 必须是服务端字面值",
  );
  const noLeaseRequest = human();
  const removed = detach(free.key, noLeaseRequest);
  assert.equal(removed.state, "removed");
  assert.equal(removed.epoch, 1);
  assert.equal(removed.revokedGeneration, 0);
  assert.equal(removed.removalMutationId, null);
  assert.equal(removed.revocation, "confirmed");
  assert(removed.removedAt && removed.requestedAt);
  assert.equal(membershipRowCount(free.key).length, 1, "移出不新增 epoch");
  assert.equal(
    db.select().from(leaseMutation).where(eq(leaseMutation.projectId, projectId)).all().length,
    0,
    "无租约移出不伪造收据",
  );
  // 重放同 requestId 返回同 epoch/receipt；异 payload 拒 remote_request_conflict。
  assert.deepEqual(detach(free.key, noLeaseRequest), removed);
  assert.throws(
    () => detach(free.key, noLeaseRequest, { expectedRevision: 2 }),
    fails("remote_request_conflict"),
  );
  // 已移出后的新请求。
  assert.throws(() => detach(free.key, human()), fails("membership_removed"));

  // 2. 有 held 租约、无在途：同事务推进 removed，收据 completed。
  const holder = actor();
  const held = machineWithMembership({ leaseHolder: holder, bindProjectB: true });
  const otherProjectHolder = actor(projectB);
  acquireLease(
    {
      projectId: projectB,
      machineId: held.machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    otherProjectHolder,
  );
  const heldView = detach(held.key, human());
  assert.equal(heldView.state, "removed");
  assert.equal(heldView.revokedGeneration, 1);
  assert.match(String(heldView.removalMutationId), /^lmu_/);
  assert.equal(heldView.revocation, "confirmed");
  const receipt = getLease(
    { ...held.key, mutationId: heldView.removalMutationId! },
    human(),
  ).mutation!;
  assert.equal(receipt.action, "reclaim");
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.completedGeneration, 2);
  assert.equal(getLease(held.key, human()).lease.state, "free");
  // 其他 Project 的绑定与租约逐列不变。
  assert.equal(
    getLease({ projectId: projectB, machineId: held.machineId }, human()).lease.generation,
    1,
  );
  assert.equal(
    db.select().from(projectMachine).where(eq(projectMachine.projectId, projectB)).all()[0]
      ?.revision,
    1,
  );

  // 3. 有在途 dispatched 未 drained：停在 detaching/fencing，人类历史仍可读。
  const busyHolder = actor();
  const busy = machineWithMembership({ leaseHolder: busyHolder });
  const executionId = dispatchExecution(busyHolder, busy.key, busy.ticket);
  const pendingView = detach(busy.key, human());
  assert.equal(pendingView.state, "detaching");
  assert.equal(pendingView.revocation, "pending");
  assert.equal(pendingView.pending?.kind, "membership_detaching");
  assert.equal(pendingView.pending?.since, pendingView.requestedAt);
  assert.equal(pendingView.pending?.canForceReclaim, true);
  assert.equal(pendingView.removedAt, null);
  assert.equal(pendingView.revokedGeneration, null);
  assert.equal(getLease(busy.key, human()).lease.state, "fencing");
  const pendingExecution = db
    .select()
    .from(remoteExecution)
    .where(eq(remoteExecution.id, executionId))
    .get()!;
  assert(pendingExecution.dispatchConnectionGeneration !== null);
  // Human 历史入口不受操作总闸影响。
  assert.equal(getExecution({ ...busy.key, executionId }, human()).executionId, executionId);
  assert.equal(listProjectExecutions({ projectId, limit: 100 }, human()).length >= 1, true);
  // Agent 在 fencing 期间不能以旧身份读。
  assert.throws(
    () => getExecution({ ...busy.key, executionId }, busyHolder),
    fails("lease_not_holder"),
  );
  // 已有 fencing 的新 detach 整笔无写。
  const beforeFence = sqlite
    .prepare("SELECT state FROM project_machine_membership WHERE project_id=? AND machine_id=?")
    .get(projectId, busy.machineId);
  assert.throws(() => detach(busy.key, human()), fails("detach_pending"));
  assert.deepEqual(
    sqlite
      .prepare("SELECT state FROM project_machine_membership WHERE project_id=? AND machine_id=?")
      .get(projectId, busy.machineId),
    beforeFence,
  );
  // 收据完成钩子推进 removed；重复调用是 no-op。
  sqlite
    .prepare(
      "UPDATE remote_execution SET state='succeeded', terminal_at=?, drained_at=? WHERE id=?",
    )
    .run(clock, clock, executionId);
  const updatedAt = tick(2000);
  assert.equal(completeReceipt(busy.key, updatedAt), true);
  const completed = membershipViewFor(busy.key, updatedAt)!;
  assert.equal(completed.state, "removed");
  assert.equal(completed.revokedGeneration, 1);
  assert.equal(completed.revocation, "confirmed");
  assert.equal(completed.pending, null);
  assert.equal(completeReceipt(busy.key, tick()), false);
  // 4. 已有不属于本次移出的 fencing（handoff pending）：整笔无写，不接管。
  const handoffHolder = actor();
  const handoffTarget = actor();
  const handingOff = machineWithMembership({ leaseHolder: handoffHolder });
  dispatchExecution(handoffHolder, handingOff.key, handingOff.ticket);
  handoffLease(
    {
      ...handingOff.key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: handoffTarget.instanceId,
    },
    handoffHolder,
  );
  const beforeFencing = membershipRowCount(handingOff.key)[0]!;
  assert.throws(() => detach(handingOff.key, human()), fails("lease_fencing"));
  assert.deepEqual(membershipRowCount(handingOff.key)[0], beforeFencing);
  assert.equal(noticeRows(handingOff.key).length, 0);
  console.log("PASS detach: free, held, in-flight detaching, fencing拒绝, CAS, replay and history");
}

if (scenario === "rejoin") {
  const machine = machineWithMembership();
  const detachRequest = human();
  const originalDetach = detachInput(machine.key, detachRequest);
  const removed = detachMachine(originalDetach, detachRequest);
  assert.equal(removed.state, "removed");
  const before = membershipRowCount(machine.key)[0]!;
  const viewer = human();
  const rejoined = rejoinProjectMachine(
    {
      ...machine.key,
      requestId: viewer.requestId,
      expectedEpoch: 1,
      expectedRevision: 1,
      confirm: true,
    },
    viewer,
  );
  assert.equal(rejoined.state, "active");
  assert.equal(rejoined.epoch, 2);
  assert.equal(rejoined.requestedAt, null);
  assert.equal(rejoined.pending, null);
  assert.equal(membershipActive(projectId, machine.key.machineId), true);
  const rows = membershipRowCount(machine.key);
  assert.equal(rows.length, 2, "rejoin 只新增 epoch+1");
  assert.deepEqual(rows[0], before, "旧 removed 行不被改写");
  const binding = db
    .select()
    .from(projectMachine)
    .where(
      and(
        eq(projectMachine.projectId, projectId),
        eq(projectMachine.machineId, machine.key.machineId),
      ),
    )
    .get();
  assert.equal(binding?.revision, 2, "重加入必须递增绑定 revision");
  // 租约 generation 不归零，也不因 rejoin 建行。
  assert.equal(
    db
      .select()
      .from(machineLease)
      .where(
        and(
          eq(machineLease.projectId, projectId),
          eq(machineLease.machineId, machine.key.machineId),
        ),
      )
      .all().length,
    0,
  );
  // 固定收敛：重放 expectedEpoch=1 只返回 epoch2，不新建、不再校验 revision。
  const replay = rejoinProjectMachine(
    {
      ...machine.key,
      requestId: req(),
      expectedEpoch: 1,
      expectedRevision: 1,
      confirm: true,
    },
    human(),
  );
  assert.deepEqual(replay, rejoined);
  assert.equal(membershipRowCount(machine.key).length, 2);
  // active 的非收敛请求是 conflict。
  assert.throws(
    () =>
      rejoinProjectMachine(
        {
          ...machine.key,
          requestId: req(),
          expectedEpoch: 2,
          expectedRevision: 3,
          confirm: true,
        },
        human(),
      ),
    fails("conflict"),
  );
  // 旧 detach 请求不能触及新 epoch；新 detach 的旧 epoch 也拒。
  assert.deepEqual(detachMachine(originalDetach, human()), removed);
  assert.throws(
    () => detach(machine.key, human(), { expectedEpoch: 1, expectedRevision: 2 }),
    fails("conflict"),
  );
  // 后续配置修改走既有 save binding，不新增 epoch。
  saveProjectMachineBinding(
    {
      projectId,
      machineId: machine.key.machineId,
      description: "after rejoin",
      expectedRevision: 2,
    },
    human(),
  );
  assert.equal(membershipRowCount(machine.key).length, 2);
  assert.equal(membershipActive(projectId, machine.key.machineId), true);
  // save binding 不会复活 removed：rejoin 前的 epoch 行仍保留原状态。
  assert.equal(membershipRowCount(machine.key)[0]!.state, "removed");
  // detaching 不能 rejoin 复活。
  const detachingHolder = actor();
  const detaching = machineWithMembership({ leaseHolder: detachingHolder });
  dispatchExecution(detachingHolder, detaching.key, detaching.ticket);
  const pendingDetach = detach(detaching.key, human());
  assert.equal(pendingDetach.state, "detaching");
  assert.throws(
    () =>
      rejoinProjectMachine(
        {
          ...detaching.key,
          requestId: req(),
          expectedEpoch: 1,
          expectedRevision: 1,
          confirm: true,
        },
        human(),
      ),
    fails("detach_pending"),
  );
  // 未 removed 的 active epoch 不能 rejoin。
  assert.throws(
    () =>
      rejoinProjectMachine(
        {
          ...machine.key,
          requestId: req(),
          expectedEpoch: 3,
          expectedRevision: 3,
          confirm: true,
        },
        human(),
      ),
    fails("conflict"),
  );
  console.log("PASS rejoin: new epoch, old rows untouched, revision CAS and convergence");
}

if (scenario === "notices") {
  const holder = actor();
  const bystander = actor();
  const machine = machineWithMembership({ leaseHolder: holder });
  const request = detachInput(machine.key, human());
  const view = detachMachine(request, human());
  assert.equal(view.state, "removed");
  const notices = noticeRows(machine.key);
  assert.equal(notices.length, 1, "只为旧 holder 的活动 run 落一条事实");
  assert.equal(notices[0]!.runId, holder.runId);
  assert.equal(notices[0]!.kind, "machine_removed");
  assert.equal(notices[0]!.deliveredAt, null);
  const cause = notices[0]!.causeId;
  assert.match(cause, /^membership:/);
  // 重试不复制原 cause。
  assert.deepEqual(detachMachine(request, human()), view);
  assert.equal(noticeRows(machine.key).length, 1);
  // 崩溃窗口：拉取两次得到同一 noticeId 与同一文本；标记前崩溃可重投。
  const first = pendingRunNotices({ runId: holder.runId }, holder);
  const second = pendingRunNotices({ runId: holder.runId }, holder);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.id, second[0]!.id);
  assert.equal(noticeDeliveryText(first[0]!), noticeDeliveryText(second[0]!));
  assert.equal(first[0]!.deliveredAt, null);
  const deliveredAt = new Date(Date.parse(first[0]!.createdAt) + 1000);
  assert.equal(markRunNoticeDelivered(first[0]!.id, deliveredAt), true);
  assert.equal(markRunNoticeDelivered(first[0]!.id, deliveredAt), false, "重复标记是 no-op");
  assert.equal(pendingRunNotices({ runId: holder.runId }, holder).length, 0);
  assert.equal(bystander.runId === holder.runId, false);
  // 回滚窗口：失败的 detach 不写 notice。
  const aborted = machineWithMembership({ leaseHolder: actor() });
  assert.throws(() => detach(aborted.key, human(), { expectedRevision: 7 }), fails("conflict"));
  assert.equal(noticeRows(aborted.key).length, 0);
  // 配额：受影响执行超过单条通知事实的上界就整笔拒绝，不截断。
  const quotaKey = { projectId, machineId: aborted.machineId };
  const executions = Array.from({ length: 257 }, () => ({
    executionId: newId(ID_PREFIXES.execution),
    runId: holder.runId,
    state: "running" as const,
  }));
  assert.throws(
    () =>
      insertRevokeNotice(db, {
        key: quotaKey,
        kind: "lease_reclaimed",
        causeId: newId(ID_PREFIXES.leaseMutation),
        generation: 1,
        revocation: "confirmed",
        executions,
        holderInstanceId: holder.instanceId,
        now: tick(),
      }),
    fails("conflict"),
  );
  assert.equal(noticeRows(quotaKey).length, 0);
  console.log("PASS notices: single cause, at-least-once window, rollback and quota");
}

if (scenario === "force") {
  const holder = actor();
  const machine = machineWithMembership({ leaseHolder: holder });
  const executionId = dispatchExecution(holder, machine.key, machine.ticket);
  const detaching = detach(machine.key, human());
  assert.equal(detaching.state, "detaching");
  const forced = forceReclaimLease(
    {
      ...machine.key,
      action: "force_reclaim",
      mutationId: detaching.removalMutationId!,
      expectedGeneration: 1,
      confirm: true,
    },
    human(),
  );
  assert.equal(forced.completedGeneration, 2);
  const advanced = sqlite
    .transaction(() => {
      const pending = db
        .select()
        .from(leaseMutation)
        .where(eq(leaseMutation.id, detaching.removalMutationId!))
        .get()!;
      return onLeaseMutationCompleted(db, pending);
    })
    .immediate();
  assert.equal(advanced, true);
  const view = membershipViewFor(machine.key, tick())!;
  assert.equal(view.state, "removed");
  assert.equal(view.revocation, "unconfirmed");
  assert.equal(view.revokedGeneration, 1);
  assert.equal(view.pending, null);
  assert.equal(
    getLease({ ...machine.key, mutationId: detaching.removalMutationId! }, human()).mutation
      ?.forcedReclaim?.mutationId,
    forced.mutationId,
  );
  assert.equal(
    db.select().from(remoteExecution).where(eq(remoteExecution.id, executionId)).get()!.state,
    "unknown",
  );
  // force override 不复制同 cause 的通知，也不改写既有投递快照。
  assert.equal(noticeRows(machine.key).length, 1);
  assert.equal(
    noticeRows(machine.key)[0]!.payloadJson.revocation,
    "pending",
    "payload 是撤权时的快照，确认从事实视图派生",
  );
  // 强制收回后仅显式 rejoin 可新建 epoch。
  const rejoined = rejoinProjectMachine(
    {
      ...machine.key,
      requestId: req(),
      expectedEpoch: 1,
      expectedRevision: 1,
      confirm: true,
    },
    human(),
  );
  assert.equal(rejoined.state, "active");
  assert.equal(rejoined.epoch, 2);
  console.log("PASS force: unconfirmed view, single cause, explicit rejoin only");
}

if (scenario === "pending") {
  // lease_fencing：交接 pending 且无 membership 移出。
  const holder = actor();
  const next = actor();
  const machine = machineWithMembership({ leaseHolder: holder });
  const executionId = dispatchExecution(holder, machine.key, machine.ticket);
  const handoff = handoffLease(
    {
      ...machine.key,
      action: "handoff",
      requestId: req(),
      expectedGeneration: 1,
      targetInstanceId: next.instanceId,
    },
    holder,
  );
  assert.equal(handoff.state, "pending");
  const mutation = db
    .select()
    .from(leaseMutation)
    .where(eq(leaseMutation.id, handoff.mutationId))
    .get()!;
  const since = mutation.createdAt;
  const humanView = pendingFactFor(machine.key, new Date(since.getTime() + 14999), {
    canForceReclaim: true,
  })!;
  assert.equal(humanView.kind, "lease_fencing");
  assert.equal(humanView.since, since.toISOString());
  assert.equal(humanView.elapsedMs, WORKER_STALE_AFTER_MS - 1);
  assert.equal(humanView.thresholdMs, WORKER_STALE_AFTER_MS);
  assert.equal(humanView.overdue, false);
  assert.equal(humanView.evidence, "awaiting_ack");
  assert.equal(humanView.canForceReclaim, true);
  const overdue = pendingFactFor(machine.key, new Date(since.getTime() + 15000), {
    canForceReclaim: true,
  })!;
  assert.equal(overdue.elapsedMs, 15000);
  assert.equal(overdue.overdue, true);
  // 非 Human 不能强制收回。
  assert.equal(
    pendingFactFor(machine.key, new Date(since.getTime() + 15000), { canForceReclaim: false })!
      .canForceReclaim,
    false,
  );
  // 在线久等与离线短等是两维：离线不把 overdue 变成 true，也不清零。
  sqlite
    .prepare("UPDATE machine_connection SET last_seen_at=0 WHERE machine_id=?")
    .run(machine.key.machineId);
  const offlineShort = pendingFactFor(machine.key, new Date(since.getTime() + 1000), {
    canForceReclaim: true,
  })!;
  assert.equal(offlineShort.workerOnline, false);
  assert.equal(offlineShort.overdue, false);
  assert.equal(offlineShort.elapsedMs, 1000);
  // 时间过去不改变收据、授权与执行终态。
  const late = pendingFactFor(machine.key, new Date(since.getTime() + 600000), {
    canForceReclaim: true,
  })!;
  assert.equal(late.kind, "lease_fencing");
  assert.equal(late.since, since.toISOString());
  assert.equal(getLease(machine.key, human()).lease.state, "fencing");
  assert.equal(
    db.select().from(remoteExecution).where(eq(remoteExecution.id, executionId)).get()!.drainedAt,
    null,
  );
  assert.equal(membershipRowCount(machine.key)[0]!.state, "active");

  // membership_detaching：移出 pending 优先于 fencing。
  const busyHolder = actor();
  const busy = machineWithMembership({ leaseHolder: busyHolder });
  dispatchExecution(busyHolder, busy.key, busy.ticket);
  const detaching = detach(busy.key, human());
  assert.equal(detaching.state, "detaching");
  const detachFact = pendingFactFor(busy.key, tick(), { canForceReclaim: true })!;
  assert.equal(detachFact.kind, "membership_detaching");
  assert.equal(detachFact.since, detaching.requestedAt);
  assert.equal(detachFact.evidence, "awaiting_ack");

  // notice_undelivered：无 pending 收据时的未投递通知。
  const noticeHolder = actor();
  const noticeMachine = machineWithMembership({ leaseHolder: noticeHolder });
  insertRevokeNotice(db, {
    key: noticeMachine.key,
    kind: "lease_released",
    causeId: newId(ID_PREFIXES.leaseMutation),
    generation: 1,
    revocation: "confirmed",
    executions: [],
    holderInstanceId: noticeHolder.instanceId,
    now: tick(),
  });
  const noticeFact = pendingFactFor(noticeMachine.key, tick(), { canForceReclaim: true })!;
  assert.equal(noticeFact.kind, "notice_undelivered");
  assert.equal(noticeFact.evidence, "delivery_unconfirmed");
  assert.equal(noticeFact.canForceReclaim, false);
  const oldest = noticeRows(noticeMachine.key)[0]!;
  assert.equal(noticeFact.since, oldest.createdAt.toISOString());
  // run 在投递前结束 → run_not_running；投递后事实消失。
  sqlite
    .prepare("UPDATE agent_run SET status='aborted', settled_at=? WHERE id=?")
    .run(clock, noticeHolder.runId);
  assert.equal(
    pendingFactFor(noticeMachine.key, tick())!.evidence,
    "run_not_running",
    "已结束 run 不冒充模型已读",
  );
  markRunNoticeDelivered(oldest.id, tick());
  assert.equal(pendingFactFor(noticeMachine.key, tick()), null);
  // 批量 membership 读：一次返回每台 Machine 的最新 epoch。
  const batch = liveMembership(projectId);
  assert.equal(batch.get(machine.key.machineId)?.state, "active");
  assert.equal(batch.get(busy.key.machineId)?.state, "detaching");
  assert.equal(batch.get(busy.key.machineId)?.removalMutationId, detaching.removalMutationId);
  console.log("PASS pending: three kinds, 14999/15000 boundary, online/offline dimensions");
}

if (scenario === "authority") {
  const machine = machineWithMembership();
  const other = human("other");
  assert.throws(() => detach(machine.key, other), fails("not_found"));
  assert.throws(
    () =>
      rejoinProjectMachine(
        {
          ...machine.key,
          requestId: other.requestId,
          expectedEpoch: 1,
          expectedRevision: 1,
          confirm: true,
        },
        other,
      ),
    fails("not_found"),
  );
  // 未绑定的 Project × Machine 不是成员关系；缺行不是 active。
  const unbound = createMachine({ name: "Unbound" }, { ...human(), now: new Date() });
  assert.throws(
    () =>
      detachMachine(
        {
          projectId,
          machineId: unbound.detail.machine.id,
          requestId: req(),
          expectedEpoch: 1,
          expectedRevision: 1,
          expectedGeneration: 0,
          confirm: true,
        },
        human(),
      ),
    fails("not_found"),
  );
  assert.equal(membershipActive(projectId, unbound.detail.machine.id), false);
  // agent 身份不能走 Human 移出入口。
  const holder = actor();
  const held = machineWithMembership({ leaseHolder: holder });
  assert.throws(() => detach(held.key, holder as unknown as MachineContext), fails("forbidden"));
  // 移出后不能再按旧持有者操作租约。
  const removed = detach(held.key, human());
  assert.equal(removed.state, "removed");
  assert.throws(
    () =>
      releaseLease(
        { ...held.key, action: "release", requestId: req(), expectedGeneration: 2 },
        holder,
      ),
    fails("lease_not_holder"),
  );
  assert.throws(
    () =>
      reclaimLease(
        { ...held.key, action: "reclaim", requestId: req(), expectedGeneration: 2, confirm: true },
        human(),
      ),
    fails("lease_not_holder"),
  );
  console.log("PASS authority: non-member not_found, removed lease refused, agent cannot detach");
}

sqlite.close();
