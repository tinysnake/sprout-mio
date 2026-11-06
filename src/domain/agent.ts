import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  AgentProfile,
  CreateAgentProfileInput,
  ProjectMember,
  UpdateAgentProfileInput,
} from "../contracts/agent";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import { publishAgentProfileChange } from "./change-feed";
import {
  agentInstance,
  agentProfile,
  agentRun,
  chat,
  chatMember,
  diagnosticEvent,
  leaseMutation,
  machine,
  machineLease,
  projectMember,
  task,
} from "../db/schema";
import {
  projectMemberRemovalBlockersSchema,
  projectMemberRemovalOutcomeSchema,
} from "../contracts/project-member-removal";
import type {
  ProjectMemberRemovalBlocker,
  ProjectMemberRemovalBlockers,
  ProjectMemberRemovalLeaseOutcome,
  ProjectMemberRemovalLeaseRef,
  ProjectMemberRemovalOutcome,
  ProjectMemberRemovalRunRef,
  ProjectMemberRemovalOwnerRef,
  ProjectMemberRemovalTaskRef,
} from "../contracts/project-member-removal";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { abortAgentRun } from "./agent-run";
import {
  getChat,
  revokeProjectAgentEnrollment,
  revokeProjectAgentEnrollmentUnchecked,
  setChatOwner,
} from "./chat";
import { actorFromContext } from "./chat-actor";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";
import type { MachineContext } from "./machine";
import { mutateTask } from "./task";
import { clearRunActivity } from "../server/pi-host/run-activity";
import { LeaseError, reclaimLeaseInTransaction } from "../server/lease";

export class AgentError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class ProjectMemberRemovalBlockedError extends Error {
  readonly code = "project_member_removal_blocked" as const;
  readonly details: ProjectMemberRemovalBlockers;
  constructor(details: ProjectMemberRemovalBlockers) {
    const hasFencing = details.blockers.some(
      (blocker) =>
        blocker.kind === "leases" && blocker.items.some((item) => item.state === "fencing"),
    );
    super(
      `该 Agent 仍有未结责任，请先处理全部阻塞${hasFencing ? "；fencing 租约请等待确认或前往租约页处理" : ""}`,
    );
    this.name = "ProjectMemberRemovalBlockedError";
    this.details = projectMemberRemovalBlockersSchema.parse(details);
  }
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

/** Four responsibility sources share one snapshot and one stable, untruncated projection. */
export function collectProjectMemberRemovalBlockers(
  projectId: string,
  agentProfileId: string,
): ProjectMemberRemovalBlocker[] {
  if (!sqlite.inTransaction)
    return sqlite
      .transaction(() => collectProjectMemberRemovalBlockers(projectId, agentProfileId))
      .deferred();
  const instances = db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(
      and(eq(agentInstance.projectId, projectId), eq(agentInstance.agentProfileId, agentProfileId)),
    )
    .all()
    .map((row: { id: string }) => row.id);
  const runs =
    instances.length === 0
      ? []
      : (db
          .select({
            runId: agentRun.id,
            instanceId: agentRun.instanceId,
            status: agentRun.status,
            chat: { chatId: chat.id, chatKind: chat.kind, title: chat.title },
          })
          .from(agentRun)
          .innerJoin(chat, eq(chat.id, agentRun.chatId))
          .where(
            and(
              eq(chat.projectId, projectId),
              eq(agentRun.projectId, projectId),
              inArray(agentRun.instanceId, instances),
              inArray(agentRun.status, ["queued", "running"]),
            ),
          )
          .all() as ProjectMemberRemovalRunRef[]);
  const leases: ProjectMemberRemovalLeaseRef[] = [];
  const currentLeases = db
    .select({ lease: machineLease, machineName: machine.name })
    .from(machineLease)
    .innerJoin(machine, eq(machine.id, machineLease.machineId))
    .where(
      and(eq(machineLease.projectId, projectId), inArray(machineLease.state, ["held", "fencing"])),
    )
    .all() as { lease: typeof machineLease.$inferSelect; machineName: string }[];
  const pendingMutations = db
    .select()
    .from(leaseMutation)
    .where(and(eq(leaseMutation.projectId, projectId), eq(leaseMutation.state, "pending")))
    .all() as (typeof leaseMutation.$inferSelect)[];
  for (const { lease, machineName } of currentLeases) {
    const pending = pendingMutations.find(
      (mutation) =>
        mutation.machineId === lease.machineId && mutation.expectedGeneration === lease.generation,
    );
    const holder = lease.holderInstanceId !== null && instances.includes(lease.holderInstanceId);
    const target =
      lease.state === "fencing" &&
      pending?.action === "handoff" &&
      pending.targetInstanceId != null &&
      instances.includes(pending.targetInstanceId);
    if ((!holder && !target) || lease.holderInstanceId === null) continue;
    leases.push({
      key: { projectId, machineId: lease.machineId },
      machineName,
      generation: lease.generation,
      state: lease.state as "held" | "fencing",
      holderInstanceId: lease.holderInstanceId,
      pendingMutationId: lease.state === "fencing" ? (pending?.id ?? null) : null,
      relation: holder ? "holder" : "handoff_target",
    });
  }
  const owners = db
    .select({ chat: { chatId: chat.id, chatKind: chat.kind, title: chat.title } })
    .from(chat)
    .where(
      and(
        eq(chat.projectId, projectId),
        eq(chat.ownerKind, "agent"),
        eq(chat.ownerId, agentProfileId),
        inArray(chat.kind, ["group", "public_channel"]),
      ),
    )
    .all() as ProjectMemberRemovalOwnerRef[];
  const tasks = db
    .select({
      taskId: task.id,
      title: task.title,
      status: task.status,
      chat: { chatId: chat.id, chatKind: chat.kind, title: chat.title },
    })
    .from(chat)
    .innerJoin(
      chatMember,
      and(
        eq(chatMember.chatId, chat.id),
        eq(chatMember.memberKind, "agent"),
        eq(chatMember.memberId, agentProfileId),
      ),
    )
    .innerJoin(task, eq(task.chatId, chat.id))
    .where(
      and(
        eq(chat.projectId, projectId),
        eq(chat.kind, "dm"),
        eq(task.projectId, projectId),
        eq(task.status, "assigned"),
      ),
    )
    .all() as ProjectMemberRemovalTaskRef[];
  const blockers: ProjectMemberRemovalBlocker[] = [];
  if (runs.length)
    blockers.push({
      kind: "active_runs",
      items: uniqueBy(runs, (row) => row.runId).sort((a, b) => compareIds(a.runId, b.runId)),
    });
  if (leases.length)
    blockers.push({
      kind: "leases",
      items: uniqueBy(leases, (row) => row.key.machineId).sort((a, b) =>
        compareIds(a.key.machineId, b.key.machineId),
      ),
    });
  if (owners.length)
    blockers.push({
      kind: "owner_duties",
      items: uniqueBy(owners, (row) => row.chat.chatId).sort((a, b) =>
        compareIds(a.chat.chatId, b.chat.chatId),
      ),
    });
  if (tasks.length)
    blockers.push({
      kind: "dm_assigned_tasks",
      items: uniqueBy(tasks, (row) => row.taskId).sort(
        (a, b) => compareIds(a.chat.chatId, b.chat.chatId) || compareIds(a.taskId, b.taskId),
      ),
    });
  return blockers.length
    ? projectMemberRemovalBlockersSchema.parse({ projectId, agentProfileId, blockers }).blockers
    : [];
}

function toAgentProfile(row: typeof agentProfile.$inferSelect): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    ...(row.jobTitle === null ? {} : { jobTitle: row.jobTitle }),
    persona: row.persona,
    harness: row.harness,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProjectMember(row: typeof projectMember.$inferSelect): ProjectMember {
  return { ...row, addedAt: row.addedAt.toISOString() };
}

/**
 * 项目级移除后的 DM 归档，与重新加入后的取消归档（`docs/communication-decisions.md`「一期」：
 * 正常移除后「其 DM 归档、不可继续聊天」，「同一 Agent 重新加入 Project 时…恢复既有 DM」）。
 *
 * 两步都落在成员的写入事务里：成员行已经变了而对话还显示可用（或反之）是不能提交的中间态。
 * DM 与 Agent 的对应关系读 `chat_member`：项目级移除按 d14 保留 DM 的成员行，
 * 所以移除后仍能按它找回要归档的对话，重新加入后也能按它恢复。
 */
function setProjectAgentDirectChatsArchived(
  projectId: string,
  agentProfileId: string,
  archivedAt: Date | null,
): void {
  const dmIds = db
    .select({ id: chat.id })
    .from(chat)
    .innerJoin(
      chatMember,
      and(
        eq(chatMember.chatId, chat.id),
        eq(chatMember.memberKind, "agent"),
        eq(chatMember.memberId, agentProfileId),
      ),
    )
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "dm")))
    .all()
    .map((row: { id: string }) => row.id);
  if (dmIds.length === 0) return;
  // 只动归档事实，不碰 owner/wake 等治理字段：归档不是治理写入，不推 governance_revision。
  db.update(chat).set({ archivedAt, updatedAt: new Date() }).where(inArray(chat.id, dmIds)).run();
}

export function createAgentProfile(
  input: CreateAgentProfileInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): AgentProfile {
  return writeIdentity(
    ctx,
    { event: "agent_profile.created", message: "Agent profile 已创建" },
    () => {
      const row = db
        .insert(agentProfile)
        .values({ id: newId(ID_PREFIXES.agentProfile), ...input, createdBy: ctx.userId })
        .returning()
        .get();
      return toAgentProfile(row);
    },
    hooks,
  );
}

export function listAgentProfiles(ctx: ProjectContext): AgentProfile[] {
  return db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.createdBy, ctx.userId))
    .orderBy(asc(agentProfile.createdAt), asc(sql`rowid`))
    .all()
    .map(toAgentProfile);
}

export function getAgentProfile(id: string, ctx: ProjectContext): AgentProfile {
  const row = db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.id, id), eq(agentProfile.createdBy, ctx.userId)))
    .get();
  if (!row) throw new AgentError("not_found", "Agent profile 不存在");
  return toAgentProfile(row);
}

export function updateAgentProfile(
  id: string,
  input: UpdateAgentProfileInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): AgentProfile {
  const profile = writeIdentity(
    ctx,
    { event: "agent_profile.updated", message: "Agent profile 已更新" },
    () => {
      getAgentProfile(id, ctx);
      const row = db
        .update(agentProfile)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(agentProfile.id, id), eq(agentProfile.createdBy, ctx.userId)))
        .returning()
        .get();
      if (!row) throw new AgentError("not_found", "Agent profile 不存在");
      return toAgentProfile(row);
    },
    hooks,
  );
  // profile 没有 projectId，但它影响所有已加入的 Project 聚合。
  publishAgentProfileChange(profile.id);
  return profile;
}

export function addProjectMember(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): ProjectMember {
  return writeIdentity(
    ctx,
    { event: "project_member.added", message: "Project 成员已添加", projectId },
    () => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const row = db
        .insert(projectMember)
        .values({ projectId, agentProfileId, addedBy: ctx.userId })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!row) throw new AgentError("conflict", "Agent 已是 Project 成员");
      // 重新加入时恢复既有 DM（归档清除）；顺序在成员行之后，同事务内一起提交。
      setProjectAgentDirectChatsArchived(projectId, agentProfileId, null);
      return toProjectMember(row);
    },
    hooks,
  );
}

export function removeProjectMember(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): void {
  // 一个事务把「参与权、在途运行、待发输入」三件事一起处理（设计 §4.4，裁定 d20）：
  // 断言的读（所有者、活跃 run）与后面的写必须原子，否则检查完到写入之间能挤进一条新的 run。
  sqlite
    .transaction(() => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const row = db
        .select({ agentProfileId: projectMember.agentProfileId })
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .get();
      // This is an idempotent no-op: concurrent retries cannot repeat cleanup or diagnostics.
      if (!row) return;
      writeIdentity(
        ctx,
        { event: "project_member.removed", message: "Project 成员已移除", projectId },
        () => {
          revokeProjectAgentEnrollment(projectId, agentProfileId);
          setProjectAgentDirectChatsArchived(projectId, agentProfileId, new Date());
          db.delete(projectMember)
            .where(
              and(
                eq(projectMember.projectId, projectId),
                eq(projectMember.agentProfileId, agentProfileId),
              ),
            )
            .run();
        },
        hooks,
      );
    })
    .immediate();
}

function emptyRemovalOutcome(
  projectId: string,
  agentProfileId: string,
): ProjectMemberRemovalOutcome {
  return {
    projectId,
    agentProfileId,
    removed: false,
    abortedRunIds: [],
    ownerTransferredChatIds: [],
    unassignedTaskIds: [],
    leases: [],
  };
}

/**
 * 强制移除的计划：直接取自常规路径的四类责任聚合函数，避免「什么算责任」有两套定义。
 * 只取能自动善后的子集：租约仅收回本项目内该 Agent 分身正在持有的。handoff_target（pending
 * handoff 的目标是被移除分身）不在自动善后范围内：没有取消原语，也不允许把占用写成 free，
 * 所以单列出来只记诊断，留给 Human 与 `completeLeaseMutation` 的确认门处理。
 */
function projectAgentRemovalPlan(projectId: string, agentProfileId: string) {
  const plan = {
    activeRunIds: [] as string[],
    heldLeases: [] as ProjectMemberRemovalLeaseRef[],
    handoffLeases: [] as ProjectMemberRemovalLeaseRef[],
    ownerChatIds: [] as string[],
    dmTaskIds: [] as string[],
  };
  for (const blocker of collectProjectMemberRemovalBlockers(projectId, agentProfileId)) {
    if (blocker.kind === "active_runs") {
      for (const item of blocker.items) plan.activeRunIds.push(item.runId);
    } else if (blocker.kind === "leases") {
      for (const item of blocker.items) {
        if (item.state === "held" && item.relation === "holder") plan.heldLeases.push(item);
        if (item.state === "fencing" && item.relation === "handoff_target")
          plan.handoffLeases.push(item);
      }
    } else if (blocker.kind === "owner_duties") {
      for (const item of blocker.items) plan.ownerChatIds.push(item.chat.chatId);
    } else {
      for (const item of blocker.items) plan.dmTaskIds.push(item.taskId);
    }
  }
  return plan;
}

/**
 * 确认旧操作权已撤销才释放：reclaim 的确认门是 `completeLeaseMutation`，只要有已下发未 drain
 * 的执行就停在 fencing+pending。任何失败都回滚成调用前的状态，这里绝不把租约写成 free。
 */
function reclaimOneLease(
  lease: ProjectMemberRemovalLeaseRef,
  ctx: MachineContext,
): ProjectMemberRemovalLeaseOutcome {
  const identity = {
    machineId: lease.key.machineId,
    machineName: lease.machineName,
  };
  // 现有入口只做「守门读 + 写」：守卫在写之前，但部分写发生在后续校对之前，
  // 所以外面再包一层 savepoint，失败时整段当没发生过。
  const savepoint = `p8c_force_reclaim_${lease.key.machineId}`;
  sqlite.exec(`SAVEPOINT ${savepoint}`);
  try {
    reclaimLeaseInTransaction(
      {
        projectId: lease.key.projectId,
        machineId: lease.key.machineId,
        // 幂等键是 (actorKind, actorId, requestId)，不含 machineId：一次移除多台机器必须各自换号。
        requestId: newId(ID_PREFIXES.request),
        action: "reclaim",
        expectedGeneration: lease.generation,
        confirm: true,
      },
      ctx,
    );
    sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
    // 非 LeaseError 是代码缺陷，不能当作「无法确认」吞掉，让它中断整个移除事务。
    if (!(error instanceof LeaseError)) throw error;
    return { ...identity, outcome: "retained", reason: error.code };
  }
  const row = db
    .select({ state: machineLease.state })
    .from(machineLease)
    .where(
      and(
        eq(machineLease.projectId, lease.key.projectId),
        eq(machineLease.machineId, lease.key.machineId),
      ),
    )
    .get();
  // 停在 fencing = 仍有在途执行，旧代次授权还没确认作废，按「保留待处理占用」处理。
  if (row?.state === "fencing")
    return { ...identity, outcome: "retained", reason: "pending_dispatched_executions" };
  return { ...identity, outcome: "released", reason: null };
}

/**
 * pending handoff 的目标就是被移除的分身时，强制移除既不落地也不释放它：租约连同待决收据原样
 * 停在 fencing，等 Human 在租约页处置。这里只负责把「留下了一笔待办占用」记成 warn，让诊断与
 * 租约页看到同一件事。真正的落地拒绝在 `completeLeaseMutation` 的确认门（见 p8c-int 报告）。
 */
function recordStrandedHandoffs(
  handoffs: readonly ProjectMemberRemovalLeaseRef[],
  projectId: string,
  ctx: MachineContext,
): void {
  for (const handoff of handoffs) {
    const target = handoff.pendingMutationId
      ? db
          .select({ targetInstanceId: leaseMutation.targetInstanceId })
          .from(leaseMutation)
          .where(eq(leaseMutation.id, handoff.pendingMutationId))
          .get()
      : undefined;
    db.insert(diagnosticEvent)
      .values({
        id: newId(ID_PREFIXES.diagnostic),
        at: ctx.now,
        level: "warn",
        event: "project_member.removal_handoff_target_left_pending",
        requestId: ctx.requestId,
        projectId,
        message: `强制移除留下了指向被移除分身的待决交接（Machine「${handoff.machineName}」），租约保留为占用待处理`,
        data: JSON.stringify({
          machineId: handoff.key.machineId,
          pendingMutationId: handoff.pendingMutationId,
          targetInstanceId: target?.targetInstanceId ?? null,
        }),
      })
      .run();
  }
}

function settleProjectAgentLeases(
  leases: readonly ProjectMemberRemovalLeaseRef[],
  projectId: string,
  ctx: MachineContext,
): ProjectMemberRemovalLeaseOutcome[] {
  const outcomes: ProjectMemberRemovalLeaseOutcome[] = [];
  for (const lease of leases) {
    const outcome = reclaimOneLease(lease, ctx);
    if (outcome.outcome === "retained") {
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "warn",
          event: "project_member.removal_lease_retained",
          requestId: ctx.requestId,
          projectId,
          message: `强制移除未能确认撤销 Machine「${outcome.machineName}」上的旧操作权（${outcome.reason}），保留待处理占用`,
          data: JSON.stringify({ machineId: outcome.machineId, reason: outcome.reason }),
        })
        .run();
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * owner 是 Agent 时，owner 档能力的兜底是 projectCreatedBy，而它正是 ctx.userId
 * （`assertProjectAccess` 已确认）。因此转接必须在剥夺参与权之前，让「owner 是 Agent」这一状态
 * 走各自的设计分支。
 */
function transferProjectAgentOwnership(chatIds: readonly string[], ctx: MachineContext): string[] {
  const transferred: string[] = [];
  const actor = actorFromContext(ctx);
  for (const chatId of chatIds) {
    const current = getChat(chatId, ctx);
    setChatOwner(chatId, { kind: "human", id: ctx.userId }, current.governanceRevision, actor);
    transferred.push(chatId);
  }
  return transferred;
}

function unassignProjectAgentDirectTasks(
  taskIds: readonly string[],
  projectId: string,
  ctx: MachineContext,
): string[] {
  const unassigned: string[] = [];
  for (const taskId of taskIds) {
    const row = db
      .select({ revision: task.revision })
      .from(task)
      .where(and(eq(task.id, taskId), eq(task.projectId, projectId)))
      .get();
    // 计划读与写入在同一个 immediate 事务内，中间没有并发窗口，直接用刚读到的 revision。
    if (!row) continue;
    mutateTask("unassign", { taskId, expectedRevision: row.revision }, ctx);
    unassigned.push(taskId);
  }
  return unassigned;
}

/**
 * 强制移除：Human 一次确认后自动完成中止与责任转接，不再要求先逐项清理。
 *
 * 顺序是硬约束：先中止本 Project 所有活动 run（`abortAgentRun` 没有批量入口），再处理租约、
 * owner 与 DM Task，最后才剥夺参与权并删成员行——否则被中止的 run 仍可能在租约释放之后写入。
 * 全部步骤在同一个 immediate 事务内，`writeIdentity` 提供与常规移除同形的诊断事件。
 *
 * 常规移除（`removeProjectMember`）保留四类阻塞语义：两条路径必须一眼可分。
 */
export function forceRemoveProjectMember(
  projectId: string,
  agentProfileId: string,
  ctx: MachineContext,
  hooks: IdentityWriteHooks = {},
): ProjectMemberRemovalOutcome {
  const abortedRunIds: string[] = [];
  const outcome = sqlite
    .transaction(() => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const membership = db
        .select({ agentProfileId: projectMember.agentProfileId })
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .get();
      // 幂等空操作：成员行已不在时不再中止、不再记诊断，也不会重复动租约与 Task。
      if (!membership) return emptyRemovalOutcome(projectId, agentProfileId);
      return writeIdentity(
        ctx,
        { event: "project_member.removed", message: "Project 成员已强制移除", projectId },
        () => {
          const plan = projectAgentRemovalPlan(projectId, agentProfileId);
          for (const runId of plan.activeRunIds) {
            abortAgentRun(runId, ctx);
            abortedRunIds.push(runId);
          }
          const leases = settleProjectAgentLeases(plan.heldLeases, projectId, ctx);
          recordStrandedHandoffs(plan.handoffLeases, projectId, ctx);
          const ownerTransferredChatIds = transferProjectAgentOwnership(plan.ownerChatIds, ctx);
          const unassignedTaskIds = unassignProjectAgentDirectTasks(plan.dmTaskIds, projectId, ctx);
          // 不能复用 `revokeProjectAgentEnrollment`：无法确认撤权的租约必须留在这里，
          // 而它会因为那个 fencing 租约再次抛错，令「保留占用」与「移除完成」互相矛盾。
          revokeProjectAgentEnrollmentUnchecked(projectId, agentProfileId);
          setProjectAgentDirectChatsArchived(projectId, agentProfileId, new Date());
          db.delete(projectMember)
            .where(
              and(
                eq(projectMember.projectId, projectId),
                eq(projectMember.agentProfileId, agentProfileId),
              ),
            )
            .run();
          return {
            projectId,
            agentProfileId,
            removed: true,
            abortedRunIds: [...abortedRunIds],
            ownerTransferredChatIds,
            unassignedTaskIds,
            leases,
          };
        },
        hooks,
      );
    })
    .immediate();
  // 与 transitionAgentRun 一致：只有最外层提交后才清内存里的活动快照。
  if (!sqlite.inTransaction) for (const runId of abortedRunIds) clearRunActivity(runId);
  return projectMemberRemovalOutcomeSchema.parse(outcome);
}

export function listProjectMembers(projectId: string, ctx: ProjectContext): ProjectMember[] {
  assertProjectAccess(ctx, projectId);
  return db
    .select()
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId))
    .orderBy(asc(projectMember.addedAt), asc(sql`rowid`))
    .all()
    .map(toProjectMember);
}
