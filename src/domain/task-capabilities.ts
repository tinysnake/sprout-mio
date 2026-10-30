import { and, eq } from "drizzle-orm";
import type { AppErrorCode } from "../contracts/result";
import type { TaskCapabilityFacts, TaskResponsibility, TaskStatus } from "../contracts/task";
import { TASK_ACTIONS, TASK_CAPABILITIES, type TaskAction } from "../contracts/task-capabilities";
import { db } from "../db";
import { agentInstance, agentProfile, chat, project, projectMember, task } from "../db/schema";
import {
  assertProjectAccess,
  ProjectAccessError,
  readRunScope,
  type ProjectContext,
} from "./access";
import { actorFromContext } from "./chat-actor";
import { ChatError, getChat, isEffectiveMember } from "./chat";
import { readChatEffectiveMembers } from "./channel";

export { TASK_ACTIONS, TASK_CAPABILITIES };
export class TaskError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message = "任务操作失败",
  ) {
    super(message);
    this.name = "TaskError";
  }
}
export function isTaskScopeError(
  error: unknown,
): error is TaskError | ChatError | ProjectAccessError {
  return (
    error instanceof TaskError || error instanceof ChatError || error instanceof ProjectAccessError
  );
}
export type TaskRow = typeof task.$inferSelect;

/** Responsibility is a current Chat fact, never the Task creator or the DM's Human owner. */
export function taskResponsibilityFacts(chatId: string, ctx: ProjectContext): TaskResponsibility {
  const current = getChat(chatId, ctx);
  const row = db.select().from(chat).where(eq(chat.id, chatId)).get()!;
  if (row.archivedAt) throw new TaskError("task_assignment_invalid", "承接对话已归档");
  const members = readChatEffectiveMembers(chatId, current.projectId);
  let kind = row.ownerKind;
  let recipient = row.ownerId;
  if (row.kind === "dm") {
    const agents = members.filter((m) => m.memberKind === "agent");
    if (agents.length !== 1)
      throw new TaskError("task_assignment_invalid", "DM 必须有唯一有效分身");
    kind = "agent";
    recipient = agents[0]!.memberId;
  }
  if (row.kind === "public_channel") {
    const parent = db.select().from(project).where(eq(project.id, row.projectId)).get()!;
    if (kind !== "human" || recipient !== parent.createdBy)
      throw new TaskError("task_assignment_invalid", "公共频道负责人必须是 Project 创建者");
  }
  if (!members.some((m) => m.memberKind === kind && m.memberId === recipient))
    throw new TaskError("task_assignment_invalid", "负责人已失去对话参与权");
  if (kind === "human") return { kind, userId: recipient };
  const profile = db
    .select({ name: agentProfile.name })
    .from(agentProfile)
    .innerJoin(projectMember, eq(projectMember.agentProfileId, agentProfile.id))
    .where(and(eq(agentProfile.id, recipient), eq(projectMember.projectId, row.projectId)))
    .get();
  if (!profile) throw new TaskError("task_assignment_invalid", "分身已移出 Project");
  const instance = db
    .select()
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.chatId, chatId),
        eq(agentInstance.projectId, row.projectId),
        eq(agentInstance.agentProfileId, recipient),
      ),
    )
    .get();
  return { kind, agentProfileId: recipient, name: profile.name, instanceId: instance?.id ?? null };
}

/** Hidden Project/Chat/run identities always fail before capability or revision checks. */
export function assertTaskReadScope(row: TaskRow, ctx: ProjectContext): void {
  assertProjectAccess(ctx, row.projectId);
  if (ctx.agent) {
    const scope = readRunScope(ctx.agent.runId);
    if (
      !scope?.active ||
      !row.chatId ||
      scope.projectId !== row.projectId ||
      scope.chatId !== row.chatId ||
      scope.instanceId !== ctx.agent.instanceId ||
      scope.agentProfileId !== ctx.agent.agentProfileId
    )
      throw new TaskError("not_found", "任务不存在");
    const member = db
      .select({ id: projectMember.agentProfileId })
      .from(projectMember)
      .where(
        and(
          eq(projectMember.projectId, row.projectId),
          eq(projectMember.agentProfileId, ctx.agent.agentProfileId),
        ),
      )
      .get();
    if (!member) throw new TaskError("not_found", "任务不存在");
    getChat(row.chatId, ctx);
  }
}
export function assertTaskWriteScope(
  row: TaskRow,
  ctx: ProjectContext,
  allowArchived = false,
): void {
  assertTaskReadScope(row, ctx);
  if (!row.chatId) return;
  const current = getChat(row.chatId, ctx);
  if (current.archivedAt && !allowArchived) throw new TaskError("forbidden", "承接对话已归档");
  if (!isEffectiveMember(actorFromContext(ctx), current))
    throw new TaskError("forbidden", "当前身份没有承接对话参与权");
}

const transitions: Record<TaskAction, readonly TaskStatus[]> = {
  create: [],
  update: ["proposed", "assigned"],
  assign: ["proposed"],
  reassign: ["assigned"],
  unassign: ["assigned"],
  start: ["assigned"],
  checklist_add: ["proposed", "assigned"],
  checklist_update: ["proposed", "assigned"],
  checklist_remove: ["proposed", "assigned"],
  record_append: ["assigned"],
  complete: ["assigned"],
  cancel: ["proposed", "assigned"],
  correct: ["proposed", "assigned", "finished", "canceled"],
  reopen: ["finished", "canceled"],
};
export function assertTaskTransition(action: TaskAction, status: TaskStatus): void {
  if (!transitions[action].includes(status))
    throw new TaskError("task_invalid_transition", "当前任务状态不允许该操作");
}

function capabilityDenial(
  action: TaskAction,
  row: TaskRow | null,
  ctx: ProjectContext,
): { code: AppErrorCode; reason: string } | undefined {
  const level = TASK_CAPABILITIES[action][ctx.agent ? "agent" : "human"];
  if (level === "never") return { code: "forbidden", reason: "当前身份不能执行该任务操作" };
  try {
    if (row) assertTaskWriteScope(row, ctx, action === "reopen");
    if (level === "responsible" && row) {
      const responsibility = row.chatId ? taskResponsibilityFacts(row.chatId, ctx) : null;
      if (
        responsibility?.kind !== "agent" ||
        responsibility.agentProfileId !== ctx.agent?.agentProfileId
      )
        return { code: "forbidden", reason: "只有当前负责分身可以执行该操作" };
    }
  } catch (error) {
    if (isTaskScopeError(error)) return { code: "forbidden", reason: "当前身份没有任务操作权" };
    throw error;
  }
}
export function assertTaskCapability(
  action: TaskAction,
  row: TaskRow | null,
  ctx: ProjectContext,
): void {
  const denied = capabilityDenial(action, row, ctx);
  if (denied) throw new TaskError(denied.code, denied.reason);
}
export function taskCapabilityFacts(row: TaskRow, ctx: ProjectContext): TaskCapabilityFacts {
  const allowedActions: TaskAction[] = [];
  const denials: TaskCapabilityFacts["denials"] = {};
  for (const action of TASK_ACTIONS) {
    let denied =
      action === "create"
        ? { code: "task_invalid_transition" as const, reason: "任务已创建" }
        : capabilityDenial(action, row, ctx);
    if (!denied) {
      try {
        assertTaskTransition(action, row.status);
      } catch {
        denied = { code: "task_invalid_transition", reason: "当前任务状态不允许该操作" };
      }
    }
    if (denied) denials[action] = denied;
    else allowedActions.push(action);
  }
  return { allowedActions, denials };
}
