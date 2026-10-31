import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  AgentProfile,
  CreateAgentProfileInput,
  ProjectMember,
  UpdateAgentProfileInput,
} from "../contracts/agent";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  chat,
  chatMember,
  leaseMutation,
  machine,
  machineLease,
  projectMember,
  task,
} from "../db/schema";
import { projectMemberRemovalBlockersSchema } from "../contracts/project-member-removal";
import type {
  ProjectMemberRemovalBlocker,
  ProjectMemberRemovalBlockers,
  ProjectMemberRemovalLeaseRef,
  ProjectMemberRemovalRunRef,
  ProjectMemberRemovalOwnerRef,
  ProjectMemberRemovalTaskRef,
} from "../contracts/project-member-removal";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { revokeProjectAgentEnrollment } from "./chat";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

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
  return writeIdentity(
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
