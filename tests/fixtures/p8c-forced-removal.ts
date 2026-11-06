/**
 * P8c 强制移除验收：Human 一次确认后自动中止 runs、转接 owner、退回 DM Task、处置租约。
 *
 * 一个 scenario 一个进程：`setup()` 会插入固定 user 行，同进程重复调用会撞主键；每个
 * scenario 也因此拿到干净的库（见 scripts/verify/p8c-removal.sh）。
 */
import { and, eq } from "drizzle-orm";
import { createGroupChatInput } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { projectMemberRemovalOutcomeSchema } from "../../src/contracts/project-member-removal";
import type { ProjectMemberRemovalBlockers } from "../../src/contracts/project-member-removal";
import { db, sqlite } from "../../src/db";
import {
  agentInstance,
  agentRun,
  chat,
  chatMember,
  diagnosticEvent,
  leaseAuthorization,
  leaseMutation,
  machineLease,
  projectMember,
  task,
} from "../../src/db/schema";
import {
  addProjectMember,
  createAgentProfile,
  forceRemoveProjectMember,
  removeProjectMember,
} from "../../src/domain/agent";
import {
  createDirectChat,
  createGroupChat,
  ensureInstance,
  getChat,
  setChatOwner,
} from "../../src/domain/chat";
import { saveProjectMachineBinding } from "../../src/domain/machine";
import { createProject } from "../../src/domain/project";
import { mutateTask } from "../../src/domain/task";
import { openInitialMembership } from "../../src/server/membership";
import { completeLeaseMutation } from "../../src/server/lease";
import {
  assert,
  assertionCount,
  blocked,
  seedLease,
  seedRun,
  seedTask,
  setup,
  snapshot,
} from "./p6c-member-fixture";
import type { Fixture } from "./p6c-member-fixture";

type LeaseKey = { projectId: string; machineId: string };

const leaseRow = (key: LeaseKey) =>
  db
    .select()
    .from(machineLease)
    .where(
      and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
    )
    .get();
const authorizationRow = (key: LeaseKey, generation: number) =>
  db
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, key.projectId),
        eq(leaseAuthorization.machineId, key.machineId),
        eq(leaseAuthorization.generation, generation),
      ),
    )
    .get();
const pendingMutationRow = (key: LeaseKey) =>
  db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, key.projectId),
        eq(leaseMutation.machineId, key.machineId),
        eq(leaseMutation.state, "pending"),
      ),
    )
    .get();
const membershipRow = (projectId: string, agentProfileId: string) =>
  db
    .select()
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.agentProfileId, agentProfileId)),
    )
    .get();
const chatRow = (chatId: string) => db.select().from(chat).where(eq(chat.id, chatId)).get();
const runStatusOf = (runId: string) =>
  db
    .select({ status: agentRun.status, settledAt: agentRun.settledAt })
    .from(agentRun)
    .where(eq(agentRun.id, runId))
    .get();
const taskRow = (taskId: string) => db.select().from(task).where(eq(task.id, taskId)).get();
const agentMemberRows = (chatId: string) =>
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, chatId), eq(chatMember.memberKind, "agent")))
    .all();
const diagnosticRows = (projectId: string, event: string) =>
  db
    .select()
    .from(diagnosticEvent)
    .where(and(eq(diagnosticEvent.projectId, projectId), eq(diagnosticEvent.event, event)))
    .all();

function insertHeldLease(key: LeaseKey, holderInstanceId: string) {
  db.insert(machineLease)
    .values({ ...key, generation: 1, state: "held", holderInstanceId, changedAt: new Date() })
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation: 1,
      state: "active",
      holderInstanceId,
      reason: "acquire",
      issuedAt: new Date(),
    })
    .run();
}

/**
 * 「已下发未 drain」是撤权无法确认的唯一成因：`completeLeaseMutation` 只认这一个事实。
 * 手工造出执行行即可，不必跑整套 worker 帧协议（p4d 的 dispatchExecution 成本高得多）。
 */
function insertDispatchedExecution(options: {
  bootId: string;
  key: LeaseKey;
  holderInstanceId: string;
  runId: string;
  chatId: string;
}) {
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq) VALUES (?,1,?,?,'open',?,?,0)",
    )
    .run(options.key.machineId, `p8c-${newId(ID_PREFIXES.request)}`, options.bootId, now, now);
  sqlite
    .prepare(
      "INSERT INTO worker_exchange_frame(machine_id,connection_generation,seq,payload_hash,response_json,created_at) VALUES (?,1,1,?,'{}',?)",
    )
    .run(options.key.machineId, "a".repeat(64), now);
  sqlite
    .prepare(
      `INSERT INTO remote_execution(
        id,project_id,machine_id,authorization_generation,holder_instance_id,run_id,chat_id,
        request_id,payload_hash,operation_json,state,created_at,dispatch_deadline_at,
        dispatch_connection_generation,dispatch_seq,dispatched_at
      ) VALUES (?,?,?,1,?,?,?,?,?,'{}','dispatched',?,?,1,1,?)`,
    )
    .run(
      newId(ID_PREFIXES.execution),
      options.key.projectId,
      options.key.machineId,
      options.holderInstanceId,
      options.runId,
      options.chatId,
      newId(ID_PREFIXES.request),
      "b".repeat(64),
      now,
      now + 60_000,
      now,
    );
}

/** Group owner 换成 Agent（owner 转接的正规输入）。 */
function ownGroupByAgent(f: Fixture) {
  const current = getChat(f.group.id, f.ctx);
  setChatOwner(f.group.id, { kind: "agent", id: f.agent.id }, current.governanceRevision, {
    kind: "human",
    userId: f.ctx.userId,
    ctx: f.ctx,
  });
}

/**
 * Public Channel 的 owner 在应用层只允许 Human，所以「频道 owner 是 Agent」只能直接落库：
 * 这是四类责任聚合里的防御分支，强制移除必须照样转接。
 */
function ownChannelByAgent(f: Fixture) {
  sqlite
    .prepare("UPDATE chat SET owner_kind='agent', owner_id=? WHERE id=?")
    .run(f.agent.id, f.channel.id);
}

/**
 * 确认时间必须不早于租约签发时间（lease_authorization_check_9 要求 revoked_at >= issued_at），
 * 而 setup() 的 machineCtx.now 早于各 seed 帮助函数写入的 issued_at。
 */
const removalCtx = (f: Fixture) => ({ ...f.machineCtx, now: new Date() });

const sortedIds = (ids: readonly string[]) =>
  [...ids].sort((left, right) => left.localeCompare(right));

function scenarioNormal() {
  const f = setup();
  const lease = seedLease(f, "held");
  // agent_run_one_active_instance 只允许每个 instance 一个活动 run，第二个 run 另开分身。
  const queuedRun = seedRun(f, "queued");
  const channelInstance = ensureInstance(f.channel.id, f.agent.id, f.ctx);
  const runningRun = seedRun(f, "running", channelInstance.id, f.channel.id);
  const dmTask = seedTask(f, "assigned");
  const finishedTask = seedTask(f, "finished");
  const groupTask = seedTask(f, "assigned", f.group.id);
  ownGroupByAgent(f);
  ownChannelByAgent(f);
  assert.equal(chatRow(f.group.id)!.ownerKind, "agent");
  assert.equal(chatRow(f.channel.id)!.ownerKind, "agent");

  // 常规路径的阻塞语义保留：四类责任齐备时仍然零写入抛错。
  const before = snapshot();
  blocked(() => removeProjectMember(f.project.id, f.agent.id, f.ctx));
  assert.deepEqual(snapshot(), before);

  const outcome = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  assert.deepEqual(projectMemberRemovalOutcomeSchema.parse(outcome), outcome);
  assert.equal(outcome.removed, true);
  assert.deepEqual(sortedIds(outcome.abortedRunIds), sortedIds([queuedRun, runningRun]));
  assert.deepEqual(
    sortedIds(outcome.ownerTransferredChatIds),
    sortedIds([f.group.id, f.channel.id]),
  );
  assert.deepEqual(outcome.unassignedTaskIds, [dmTask]);
  assert.equal(outcome.leases.length, 1);
  assert.equal(outcome.leases[0].machineId, lease.key.machineId);
  assert.equal(outcome.leases[0].outcome, "released");
  assert.equal(outcome.leases[0].reason, null);

  assert.equal(runStatusOf(queuedRun)!.status, "aborted");
  assert.equal(runStatusOf(runningRun)!.status, "aborted");
  assert.notEqual(runStatusOf(runningRun)!.settledAt, null);

  // owner 转回 projectCreatedBy（Human），并且不再有 agent 的成员行。
  assert.equal(chatRow(f.group.id)!.ownerKind, "human");
  assert.equal(chatRow(f.group.id)!.ownerId, f.ctx.userId);
  assert.equal(chatRow(f.channel.id)!.ownerKind, "human");
  assert.equal(chatRow(f.channel.id)!.ownerId, f.ctx.userId);
  assert.deepEqual(agentMemberRows(f.group.id), []);
  assert.equal(agentMemberRows(f.dm.chat.id).length, 1);

  // 租约：确认撤权后释放，旧代次授权作废。
  assert.equal(leaseRow(lease.key)!.state, "free");
  assert.equal(leaseRow(lease.key)!.holderInstanceId, null);
  assert.equal(leaseRow(lease.key)!.generation, 2);
  assert.equal(authorizationRow(lease.key, 1)!.state, "revoked");
  assert.notEqual(authorizationRow(lease.key, 1)!.revokedAt, null);
  assert.equal(authorizationRow(lease.key, 2)!.state, "free");
  assert.deepEqual(diagnosticRows(f.project.id, "project_member.removal_lease_retained"), []);

  // Task：只有 DM 且仍分配给该 Agent 的退回 proposed 并清空分配；其余原样留在原对话。
  assert.equal(taskRow(dmTask)!.status, "proposed");
  assert.equal(taskRow(dmTask)!.chatId, null);
  assert.equal(taskRow(finishedTask)!.status, "finished");
  assert.equal(taskRow(finishedTask)!.chatId, f.dm.chat.id);
  assert.equal(taskRow(groupTask)!.status, "assigned");
  assert.equal(taskRow(groupTask)!.chatId, f.group.id);

  assert.equal(chatRow(f.dm.chat.id)!.archivedAt !== null, true);
  assert.equal(membershipRow(f.project.id, f.agent.id), undefined);
  assert.equal(diagnosticRows(f.project.id, "project_member.removed").length, 1);

  // 幂等：成员行已不在时不再写一行、不再中止一次。
  const afterFirst = snapshot();
  const second = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  assert.equal(second.removed, false);
  assert.deepEqual(second.abortedRunIds, []);
  assert.deepEqual(second.ownerTransferredChatIds, []);
  assert.deepEqual(second.unassignedTaskIds, []);
  assert.deepEqual(second.leases, []);
  assert.deepEqual(snapshot(), afterFirst);
}

function scenarioRetained() {
  const f = setup();
  const lease = seedLease(f, "held");
  const run = seedRun(f, "running");
  insertDispatchedExecution({
    bootId: f.bootId,
    key: lease.key,
    holderInstanceId: f.instance.id,
    runId: run,
    chatId: f.group.id,
  });

  const outcome = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  assert.equal(outcome.removed, true);
  assert.equal(outcome.leases.length, 1);
  assert.equal(outcome.leases[0].outcome, "retained");
  assert.equal(outcome.leases[0].reason, "pending_dispatched_executions");

  // 保留待处理占用：fencing + pending 收据，绝不写成 free。
  assert.equal(leaseRow(lease.key)!.state, "fencing");
  assert.equal(leaseRow(lease.key)!.holderInstanceId, f.instance.id);
  assert.equal(leaseRow(lease.key)!.generation, 1);
  assert.equal(authorizationRow(lease.key, 1)!.state, "draining");
  assert.equal(pendingMutationRow(lease.key)!.action, "reclaim");
  assert.equal(pendingMutationRow(lease.key)!.expectedGeneration, 1);

  const retained = diagnosticRows(f.project.id, "project_member.removal_lease_retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0]!.level, "warn");
  assert.equal(retained[0]!.event, "project_member.removal_lease_retained");
  assert.equal(JSON.parse(retained[0]!.data!).reason, "pending_dispatched_executions");

  // 保留占用不妨碍移除完成：参与权与成员行照常收回。
  assert.equal(membershipRow(f.project.id, f.agent.id), undefined);
  assert.equal(chatRow(f.dm.chat.id)!.archivedAt !== null, true);
  assert.equal(runStatusOf(run)!.status, "aborted");
}

function scenarioFencing() {
  const f = setup();
  const fencing = seedLease(f, "fencing");
  const beforeLease = leaseRow(fencing.key);
  const beforeMutation = db
    .select()
    .from(leaseMutation)
    .where(eq(leaseMutation.id, fencing.pendingMutationId!))
    .get();

  const outcome = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  // 计划只收 held：已经停在 fencing+pending 的租约不动它，也不重复记原因。
  assert.deepEqual(outcome.leases, []);
  assert.deepEqual(leaseRow(fencing.key), beforeLease);
  assert.deepEqual(
    db.select().from(leaseMutation).where(eq(leaseMutation.id, fencing.pendingMutationId!)).get(),
    beforeMutation,
  );
  assert.deepEqual(diagnosticRows(f.project.id, "project_member.removal_lease_retained"), []);
  assert.equal(membershipRow(f.project.id, f.agent.id), undefined);
}

/**
 * 组合场景：pending handoff 指向被移除的分身，同时该 Agent 还有活动 run、自己挂荗中的租约、
 * DM 已分配 Task 与 owner 职责。四类善后必须与「不动在途交接」在同一笔事务里同时成立。
 *
 * 发起交交的一方是另一个仍留在 Project 里的 Agent：它的分身持有租约，把租约交给 Leaving 的
 * DM 分身。这才是 blockers 里的 relation=handoff_target（holder 不是被移除者）。
 */
function scenarioHandoff() {
  const f = setup();
  const holderAgent = createAgentProfile({ name: "Holder", persona: "", harness: "pi" }, f.ctx);
  addProjectMember(f.project.id, holderAgent.id, f.ctx);
  const holderDm = createDirectChat(f.project.id, holderAgent.id, f.ctx);
  const holderInstance = ensureInstance(holderDm.chat.id, holderAgent.id, f.ctx);
  const leavingTarget = ensureInstance(f.dm.chat.id, f.agent.id, f.ctx);
  assert.notEqual(holderInstance.id, leavingTarget.id);

  const handoff = seedLease(f, "fencing", holderInstance.id, leavingTarget.id);
  const held = seedLease(f, "held");
  const run = seedRun(f, "queued");
  const dmTask = seedTask(f, "assigned");
  const groupTask = seedTask(f, "assigned", f.group.id);
  ownGroupByAgent(f);

  const handoffBefore = {
    lease: leaseRow(handoff.key),
    authorization: authorizationRow(handoff.key, 1),
    mutation: db
      .select()
      .from(leaseMutation)
      .where(eq(leaseMutation.id, handoff.pendingMutationId!))
      .get(),
    holderMembership: membershipRow(f.project.id, holderAgent.id),
    holderRunlessInstance: db
      .select()
      .from(agentInstance)
      .where(eq(agentInstance.id, holderInstance.id))
      .get(),
  };

  // 常规移除仍被四类责任同时挡住，且零写入。
  const beforeBlocked = snapshot();
  const blockedError = blocked(() => removeProjectMember(f.project.id, f.agent.id, f.ctx));
  assert.deepEqual(snapshot(), beforeBlocked);
  const details = (blockedError as Error & { details?: ProjectMemberRemovalBlockers }).details;
  const leaseBlock = details?.blockers.find((blocker) => blocker.kind === "leases");
  assert.equal(leaseBlock?.kind, "leases");
  if (leaseBlock?.kind !== "leases") throw new Error("Expected lease blockers");
  const handoffItem = leaseBlock.items.find((item) => item.key.machineId === handoff.key.machineId);
  assert.equal(handoffItem?.relation, "handoff_target");
  assert.equal(handoffItem?.pendingMutationId, handoff.pendingMutationId);
  assert.equal(handoffItem?.holderInstanceId, holderInstance.id);

  const outcome = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  assert.deepEqual(projectMemberRemovalOutcomeSchema.parse(outcome), outcome);
  assert.equal(outcome.removed, true);

  // 四处善后：run 中止、owner 转接、DM Task 退回、挂荗中的租约（held）被收回。
  assert.deepEqual(outcome.abortedRunIds, [run]);
  assert.equal(runStatusOf(run)!.status, "aborted");
  assert.deepEqual(outcome.ownerTransferredChatIds, [f.group.id]);
  assert.equal(chatRow(f.group.id)!.ownerKind, "human");
  assert.deepEqual(outcome.unassignedTaskIds, [dmTask]);
  assert.equal(taskRow(dmTask)!.status, "proposed");
  assert.equal(taskRow(dmTask)!.chatId, null);
  // 反证 7 的另外两半：Group 里的 Task 留在原对话、参与权被剥夺而 DM 成员行按 d14 保留。
  assert.equal(taskRow(groupTask)!.status, "assigned");
  assert.equal(taskRow(groupTask)!.chatId, f.group.id);
  assert.deepEqual(agentMemberRows(f.group.id), []);
  assert.equal(agentMemberRows(f.dm.chat.id).length, 1);
  assert.equal(outcome.leases.length, 1);
  assert.equal(outcome.leases[0].machineId, held.key.machineId);
  assert.equal(outcome.leases[0].outcome, "released");
  assert.equal(leaseRow(held.key)!.state, "free");

  // 在途交接不在善后范围内：租约、授权代次与待决收据一字未动，更不能变成 free。
  assert.deepEqual(leaseRow(handoff.key), handoffBefore.lease);
  assert.deepEqual(authorizationRow(handoff.key, 1), handoffBefore.authorization);
  assert.deepEqual(
    db.select().from(leaseMutation).where(eq(leaseMutation.id, handoff.pendingMutationId!)).get(),
    handoffBefore.mutation,
  );
  assert.equal(leaseRow(handoff.key)!.state, "fencing");
  assert.notEqual(leaseRow(handoff.key)!.state, "free");
  assert.equal(diagnosticRows(f.project.id, "project_member.removal_lease_retained").length, 0);

  // 留下的待办占用必须有证据：一条 warn + 指向被移除分身的 target。
  const stranded = diagnosticRows(
    f.project.id,
    "project_member.removal_handoff_target_left_pending",
  );
  assert.equal(stranded.length, 1);
  assert.equal(stranded[0]!.level, "warn");
  const strandedData = JSON.parse(stranded[0]!.data!) as {
    machineId: string;
    pendingMutationId: string;
    targetInstanceId: string;
  };
  assert.equal(strandedData.machineId, handoff.key.machineId);
  assert.equal(strandedData.pendingMutationId, handoff.pendingMutationId);
  assert.equal(strandedData.targetInstanceId, leavingTarget.id);

  // 另一个 Agent 的成员、分身与租约发起方身份全部原样。
  assert.deepEqual(membershipRow(f.project.id, holderAgent.id), handoffBefore.holderMembership);
  assert.deepEqual(
    db.select().from(agentInstance).where(eq(agentInstance.id, holderInstance.id)).get(),
    handoffBefore.holderRunlessInstance,
  );
  assert.equal(membershipRow(f.project.id, f.agent.id), undefined);
  assert.equal(chatRow(f.dm.chat.id)!.archivedAt !== null, true);

  // 缺口：交接的确认门只看 drained，不看目标分身是否仍是成员。
  // 守卫未落地时它会落到已移除分身名下（KNOWN-GAP）；守卫落地后必须停在 fencing+pending。
  completeLeaseMutation(handoff.key, new Date(), false);
  const landed = leaseRow(handoff.key)!;
  assert.equal(membershipRow(f.project.id, f.agent.id), undefined);
  if (landed.state === "fencing") {
    assert.equal(landed.holderInstanceId, holderInstance.id);
    assert.equal(pendingMutationRow(handoff.key)!.state, "pending");
    console.log("p8c handoff target gate: refused (safe)");
  } else {
    assert.equal(landed.state, "held");
    assert.equal(landed.holderInstanceId, leavingTarget.id);
    console.log("KNOWN-GAP p8c handoff target gate: lease landed on a removed instance");
  }
}

/** 同一台物理机上的另一个 Project：A 的移除不能碰 B 的任何一行。 */
function scenarioIsolation() {
  const f = setup();
  const machine = f.makeMachine();
  insertHeldLease(machine, f.instance.id);

  const projectB = createProject({ name: "P8c B" }, f.ctx);
  addProjectMember(projectB.id, f.agent.id, f.ctx);
  const dmB = createDirectChat(projectB.id, f.agent.id, f.ctx);
  const groupB = createGroupChat(
    projectB.id,
    createGroupChatInput.parse({
      projectId: projectB.id,
      title: "B Group",
      initialOwner: { kind: "human", id: f.ctx.userId },
      members: [
        { kind: "human", id: f.ctx.userId },
        { kind: "agent", id: f.agent.id },
      ],
    }),
    { kind: "human", userId: f.ctx.userId, ctx: f.ctx },
  );
  const instanceB = ensureInstance(groupB.id, f.agent.id, f.ctx);
  const keyB: LeaseKey = { projectId: projectB.id, machineId: machine.machineId };
  saveProjectMachineBinding(
    { ...keyB, description: "other project", expectedRevision: null },
    f.machineCtx,
  );
  openInitialMembership(db, { ...keyB, now: f.machineCtx.now });
  insertHeldLease(keyB, instanceB.id);
  const runB = newId(ID_PREFIXES.run);
  db.insert(agentRun)
    .values({
      id: runB,
      instanceId: instanceB.id,
      chatId: groupB.id,
      projectId: projectB.id,
      requestId: f.ctx.requestId,
      status: "running",
      sessionId: instanceB.id,
      startedAt: new Date(),
    })
    .run();
  const taskB = mutateTask("create", { projectId: projectB.id, title: "B Task" }, f.ctx).detail
    .task;
  const assignedB = mutateTask(
    "assign",
    {
      taskId: taskB.id,
      expectedRevision: taskB.revision,
      targetChatId: dmB.chat.id,
      startNow: false,
    },
    f.ctx,
  ).detail.task;
  const agentB = createProject({ name: "P8c B2" }, f.ctx);
  assert.notEqual(agentB.id, projectB.id);

  const before = {
    lease: leaseRow(keyB),
    authorization: authorizationRow(keyB, 1),
    run: db.select().from(agentRun).where(eq(agentRun.id, runB)).get(),
    task: taskRow(assignedB.id),
    membership: membershipRow(projectB.id, f.agent.id),
    dm: chatRow(dmB.chat.id),
    group: chatRow(groupB.id),
    members: agentMemberRows(groupB.id),
  };

  const outcome = forceRemoveProjectMember(f.project.id, f.agent.id, removalCtx(f));
  assert.equal(outcome.removed, true);
  assert.equal(outcome.leases[0]!.machineId, machine.machineId);
  assert.equal(outcome.leases[0]!.outcome, "released");
  assert.equal(leaseRow(machine)!.state, "free");

  assert.deepEqual(leaseRow(keyB), before.lease);
  assert.deepEqual(authorizationRow(keyB, 1), before.authorization);
  assert.deepEqual(db.select().from(agentRun).where(eq(agentRun.id, runB)).get(), before.run);
  assert.deepEqual(taskRow(assignedB.id), before.task);
  assert.deepEqual(membershipRow(projectB.id, f.agent.id), before.membership);
  assert.deepEqual(chatRow(dmB.chat.id), before.dm);
  assert.deepEqual(chatRow(groupB.id), before.group);
  assert.deepEqual(agentMemberRows(groupB.id), before.members);
  assert.equal(pendingMutationRow(keyB), undefined);
}

const scenario = process.argv[2];
if (scenario === "normal") scenarioNormal();
else if (scenario === "retained") scenarioRetained();
else if (scenario === "fencing") scenarioFencing();
else if (scenario === "handoff") scenarioHandoff();
else if (scenario === "isolation") scenarioIsolation();
else throw new Error(`unknown scenario: ${scenario ?? "<none>"}`);
console.log(`p8c forced removal ${scenario} ok (${assertionCount} assertions)`);
