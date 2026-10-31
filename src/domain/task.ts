import { signalScheduleChange } from "./chat-schedule";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import * as contract from "../contracts/task";
import type { TaskAction } from "../contracts/task-capabilities";
import { chatDisplayTitle, type Chat } from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentProfile,
  agentRun,
  chat,
  chatEffectiveMember,
  message,
  projectMember,
  task,
  taskChecklistItem,
  taskEvent,
} from "../db/schema";
import { assertProjectAccess, readRunScope, type ProjectContext } from "./access";
import { getChat, isEffectiveMember } from "./chat";
import { actorFromContext } from "./chat-actor";
import { appendTaskStartRecord, cancelTaskStartInputs } from "./task-input";
import {
  assertTaskCapability,
  assertTaskReadScope,
  assertTaskWriteScope,
  assertTaskTransition,
  isTaskScopeError,
  taskCapabilityFacts,
  taskResponsibilityFacts,
  TaskError,
  type TaskRow,
} from "./task-capabilities";

export { TaskError, assertTaskTransition } from "./task-capabilities";
export const taskCommandSchemas = {
  create: contract.createTaskInputSchema,
  update: contract.updateTaskInputSchema,
  assign: contract.assignTaskInputSchema,
  reassign: contract.reassignTaskInputSchema,
  unassign: contract.unassignTaskInputSchema,
  start: contract.startTaskInputSchema,
  complete: contract.completeTaskInputSchema,
  cancel: contract.cancelTaskInputSchema,
  correct: contract.correctTaskInputSchema,
  reopen: contract.reopenTaskInputSchema,
  checklist_add: contract.addTaskChecklistItemInputSchema,
  checklist_update: contract.updateTaskChecklistItemInputSchema,
  checklist_remove: contract.removeTaskChecklistItemInputSchema,
  record_append: contract.appendTaskRecordInputSchema,
};
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), input: taskCommandSchemas.create }),
  z.object({ action: z.literal("update"), input: taskCommandSchemas.update }),
  z.object({ action: z.literal("assign"), input: taskCommandSchemas.assign }),
  z.object({ action: z.literal("reassign"), input: taskCommandSchemas.reassign }),
  z.object({ action: z.literal("unassign"), input: taskCommandSchemas.unassign }),
  z.object({ action: z.literal("start"), input: taskCommandSchemas.start }),
  z.object({ action: z.literal("complete"), input: taskCommandSchemas.complete }),
  z.object({ action: z.literal("cancel"), input: taskCommandSchemas.cancel }),
  z.object({ action: z.literal("correct"), input: taskCommandSchemas.correct }),
  z.object({ action: z.literal("reopen"), input: taskCommandSchemas.reopen }),
  z.object({ action: z.literal("checklist_add"), input: taskCommandSchemas.checklist_add }),
  z.object({ action: z.literal("checklist_update"), input: taskCommandSchemas.checklist_update }),
  z.object({ action: z.literal("checklist_remove"), input: taskCommandSchemas.checklist_remove }),
  z.object({ action: z.literal("record_append"), input: taskCommandSchemas.record_append }),
]);

function taskRow(id: string, ctx: ProjectContext): TaskRow {
  const row = db.select().from(task).where(eq(task.id, id)).get();
  if (!row) throw new TaskError("not_found", "任务不存在");
  assertTaskReadScope(row, ctx);
  return row;
}
function lastRecordSeq(taskId: string): number | null {
  return db
    .select({ seq: sql<number | null>`max(${message.taskRecordSeq})` })
    .from(message)
    .where(eq(message.taskId, taskId))
    .get()!.seq;
}
function metadata(
  input: Partial<
    Pick<contract.Task, "title" | "description" | "constraints" | "completionRequirements">
  >,
) {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    ...(input.completionRequirements === undefined
      ? {}
      : { completionRequirements: input.completionRequirements }),
  };
}
function checklistAdd(taskId: string, body: string, now: Date): string {
  const position =
    db
      .select({ max: sql<number>`coalesce(max(${taskChecklistItem.position}),0)` })
      .from(taskChecklistItem)
      .where(eq(taskChecklistItem.taskId, taskId))
      .get()!.max + 1;
  const id = newId(ID_PREFIXES.taskChecklistItem);
  db.insert(taskChecklistItem)
    .values({ id, taskId, position, body, createdAt: now, updatedAt: now })
    .run();
  return id;
}
function checklistChange(
  taskId: string,
  itemId: string,
  patch: { body?: string; checked?: boolean; removedAt?: Date },
  now: Date,
): void {
  const changed = db
    .update(taskChecklistItem)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(taskChecklistItem.id, itemId),
        eq(taskChecklistItem.taskId, taskId),
        isNull(taskChecklistItem.removedAt),
      ),
    )
    .run().changes;
  if (!changed) throw new TaskError("not_found", "清单条目不存在");
}
function appendRecord(
  row: TaskRow,
  kind: "progress" | "correction",
  input: { body: string; referenceMessageId?: string },
  ctx: ProjectContext,
): void {
  if (!row.chatId) throw new TaskError("task_invalid_transition", "任务尚未分配承接对话");
  if (input.referenceMessageId) {
    const reference = db
      .select()
      .from(message)
      .where(eq(message.id, input.referenceMessageId))
      .get();
    if (!reference || reference.chatId !== row.chatId)
      throw new TaskError("task_reference_forbidden", "只能引用当前承接对话中可读取的消息");
    try {
      getChat(reference.chatId, ctx);
    } catch (error) {
      if (!isTaskScopeError(error)) throw error;
      throw new TaskError("task_reference_forbidden", "引用消息不可读取");
    }
  }
  db.insert(message)
    .values({
      id: newId(ID_PREFIXES.message),
      chatId: row.chatId,
      senderKind: ctx.agent ? "agent" : "human",
      senderId: ctx.agent?.agentProfileId ?? ctx.userId,
      body: input.body,
      taskId: row.id,
      taskProjectId: row.projectId,
      taskRecordSeq: (lastRecordSeq(row.id) ?? 0) + 1,
      taskRecordKind: kind,
      taskReferenceMessageId: input.referenceMessageId ?? null,
      taskAuthorRunId: ctx.agent?.runId ?? null,
    })
    .run();
}
function assignmentTarget(chatId: string, projectId: string, ctx: ProjectContext): void {
  try {
    const current = getChat(chatId, ctx);
    if (
      current.projectId !== projectId ||
      current.archivedAt ||
      !isEffectiveMember(actorFromContext(ctx), current)
    )
      throw new TaskError("task_assignment_invalid");
    taskResponsibilityFacts(chatId, ctx);
  } catch (error) {
    if (!isTaskScopeError(error)) throw error;
    throw new TaskError("task_assignment_invalid", "目标对话不能承接该任务");
  }
}
function writeEvent(
  row: TaskRow,
  previous: TaskRow | null,
  action: TaskAction,
  checklistItemId: string | null,
  ctx: ProjectContext,
  now: Date,
): void {
  db.insert(taskEvent)
    .values({
      id: newId(ID_PREFIXES.taskEvent),
      taskId: row.id,
      projectId: row.projectId,
      seq: row.revision,
      action,
      actorKind: ctx.agent ? "agent" : "human",
      actorId: ctx.agent?.agentProfileId ?? ctx.userId,
      actorRunId: ctx.agent?.runId ?? null,
      fromStatus: previous?.status ?? null,
      toStatus: row.status,
      fromChatId: previous?.chatId ?? null,
      toChatId: row.chatId,
      recordSeqAtEvent: lastRecordSeq(row.id),
      checklistItemId,
      createdAt: now,
    })
    .run();
}

/** Only known constraint failures become safe business errors; unknown SQLite failures reach the internal boundary. */
function rethrowTaskError(error: unknown): never {
  if (error instanceof TaskError) throw error;
  let current = error;
  const messages: string[] = [];
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  const text = messages.join("\n");
  for (const code of [
    "task_invalid_transition",
    "task_record_required",
    "task_record_immutable",
  ] as const)
    if (text.includes(code))
      throw new TaskError(
        code,
        code === "task_record_required"
          ? "完成任务需要末条进度或纠正记录"
          : "任务操作违反记录或状态约束",
      );
  if (
    /task_(revision_conflict|record_invalid|event_invalid|input_invalid|record_not_assistant|event_immutable|checklist_invalid)|UNIQUE constraint failed: (task|message\.task)/.test(
      text,
    )
  )
    throw new TaskError("conflict", "任务已变化，请刷新后重试");
  throw error;
}

/** Schema → scope → capability → CAS → transition/target → bounded writes → cancel obsolete input → event → detail. */
export function mutateTask(
  action: TaskAction,
  raw: unknown,
  ctx: ProjectContext,
): contract.TaskCommandResult {
  const command = commandSchema.parse({ action, input: raw });
  try {
    return sqlite
      .transaction(() => {
        const now = new Date();
        if (command.action === "create") {
          const input = command.input;
          assertProjectAccess(ctx, input.projectId);
          assertTaskCapability("create", null, ctx);
          const row = db
            .insert(task)
            .values({
              id: newId(ID_PREFIXES.task),
              projectId: input.projectId,
              ...metadata(input),
              title: input.title,
              createdBy: ctx.userId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          for (const body of input.checklist ?? []) checklistAdd(row.id, body, now);
          writeEvent(row, null, "create", null, ctx, now);
          return { detail: readTaskDetail(row, ctx) };
        }
        const previous = taskRow(command.input.taskId, ctx);
        assertTaskWriteScope(previous, ctx, command.action === "reopen");
        assertTaskCapability(command.action, previous, ctx);
        if (command.input.expectedRevision !== previous.revision)
          throw new TaskError("conflict", "任务版本已变化，请刷新后重试");
        assertTaskTransition(command.action, previous.status);
        let patch: Partial<typeof task.$inferInsert> = {};
        let checklistItemId: string | null = null;
        let startNow = false;
        switch (command.action) {
          case "update":
            patch = metadata(command.input);
            break;
          case "assign":
          case "reassign":
            assignmentTarget(command.input.targetChatId, previous.projectId, ctx);
            patch = { chatId: command.input.targetChatId, status: "assigned" };
            startNow = command.input.startNow;
            break;
          case "unassign":
            patch = { chatId: null, status: "proposed" };
            break;
          case "start":
            startNow = true;
            break;
          case "record_append":
            appendRecord(previous, "progress", command.input, ctx);
            break;
          case "complete":
            if (command.input.appendRecord)
              appendRecord(previous, "progress", command.input.appendRecord, ctx);
            if (
              lastRecordSeq(previous.id) === null ||
              db
                .select()
                .from(message)
                .where(
                  and(
                    eq(message.taskId, previous.id),
                    eq(message.taskRecordSeq, lastRecordSeq(previous.id)!),
                  ),
                )
                .get()?.taskRecordKind === "start"
            )
              throw new TaskError("task_record_required", "完成任务需要末条进度或纠正记录");
            patch = { status: "finished" };
            break;
          case "cancel":
            patch = { status: "canceled" };
            break;
          case "reopen": {
            if (previous.chatId && command.input.initialChatId !== undefined)
              throw new TaskError("task_assignment_invalid", "重开须保留原承接对话");
            const target = previous.chatId ?? command.input.initialChatId;
            if (!target)
              throw new TaskError("task_assignment_invalid", "无原承接对话，须指定初始对话");
            assignmentTarget(target, previous.projectId, ctx);
            patch = { status: "assigned", chatId: target };
            break;
          }
          case "correct":
            patch = metadata(command.input);
            if (command.input.record) {
              if (previous.status !== "finished")
                throw new TaskError("task_invalid_transition", "只有已完成任务可以纠正结果记录");
              appendRecord(previous, "correction", command.input.record, ctx);
            }
            for (const item of command.input.checklist?.add ?? [])
              checklistAdd(previous.id, item.body, now);
            for (const item of command.input.checklist?.update ?? [])
              checklistChange(
                previous.id,
                item.itemId,
                {
                  ...(item.body === undefined ? {} : { body: item.body }),
                  ...(item.checked === undefined ? {} : { checked: item.checked }),
                },
                now,
              );
            for (const itemId of command.input.checklist?.removeIds ?? [])
              checklistChange(previous.id, itemId, { removedAt: now }, now);
            break;
          case "checklist_add":
            checklistItemId = checklistAdd(previous.id, command.input.body, now);
            break;
          case "checklist_update":
            checklistItemId = command.input.itemId;
            checklistChange(
              previous.id,
              checklistItemId,
              {
                ...(command.input.body === undefined ? {} : { body: command.input.body }),
                ...(command.input.checked === undefined ? {} : { checked: command.input.checked }),
              },
              now,
            );
            break;
          case "checklist_remove":
            checklistItemId = command.input.itemId;
            checklistChange(previous.id, checklistItemId, { removedAt: now }, now);
            break;
        }
        const assignmentChanged = [
          "assign",
          "reassign",
          "unassign",
          "complete",
          "cancel",
          "reopen",
        ].includes(command.action);
        const row = db
          .update(task)
          .set({
            ...patch,
            revision: previous.revision + 1,
            assignmentRevision: previous.assignmentRevision + (assignmentChanged ? 1 : 0),
            updatedAt: now,
          })
          .where(and(eq(task.id, previous.id), eq(task.revision, command.input.expectedRevision)))
          .returning()
          .get();
        if (!row) throw new TaskError("conflict", "任务版本已变化，请刷新后重试");
        if (assignmentChanged) cancelTaskStartInputs(row.id);
        const startDelivery = startNow ? appendTaskStartRecord(row, ctx) : undefined;
        writeEvent(row, previous, command.action, checklistItemId, ctx, now);
        return { detail: readTaskDetail(row, ctx), ...(startDelivery ? { startDelivery } : {}) };
      })
      .immediate();
  } catch (error) {
    return rethrowTaskError(error);
  } finally {
    signalScheduleChange();
  }
}

function displayTitle(current: Chat): string {
  const names = db
    .select({ name: agentProfile.name })
    .from(agentProfile)
    .innerJoin(
      chatEffectiveMember,
      and(
        eq(chatEffectiveMember.memberKind, "agent"),
        eq(chatEffectiveMember.memberId, agentProfile.id),
      ),
    )
    .where(eq(chatEffectiveMember.chatId, current.id))
    .orderBy(asc(agentProfile.id))
    .all()
    .map((r: { name: string }) => r.name);
  return chatDisplayTitle(current, names);
}
function readTaskDetail(row: TaskRow, ctx: ProjectContext): contract.TaskDetail {
  const current = row.chatId ? getChat(row.chatId, ctx) : null;
  let responsibility: contract.TaskResponsibility | null = null;
  if (row.chatId) {
    try {
      responsibility = taskResponsibilityFacts(row.chatId, ctx);
    } catch (error) {
      if (!isTaskScopeError(error)) throw error;
      // Historical tasks remain readable after responsibility is revoked.
    }
  }
  const records: contract.TaskRecordView[] = db
    .select()
    .from(message)
    .where(eq(message.taskId, row.id))
    .orderBy(asc(message.taskRecordSeq))
    .all()
    .map((saved: typeof message.$inferSelect) => {
      if (ctx.agent && saved.chatId !== row.chatId)
        return {
          visibility: "restricted",
          taskId: row.id,
          seq: saved.taskRecordSeq!,
          chatId: saved.chatId,
        };
      return {
        visibility: "readable",
        messageId: saved.id,
        taskId: row.id,
        seq: saved.taskRecordSeq!,
        chatId: saved.chatId,
        kind: saved.taskRecordKind!,
        senderKind: saved.senderKind,
        senderId: saved.senderId,
        body: saved.body,
        ...(saved.taskReferenceMessageId
          ? { referenceMessageId: saved.taskReferenceMessageId }
          : {}),
        ...(saved.taskAuthorRunId ? { authorRunId: saved.taskAuthorRunId } : {}),
        createdAt: saved.createdAt.toISOString(),
      };
    });
  const events: contract.TaskEvent[] = db
    .select()
    .from(taskEvent)
    .where(eq(taskEvent.taskId, row.id))
    .orderBy(asc(taskEvent.seq))
    .all()
    .map((event: typeof taskEvent.$inferSelect) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }));
  const completionHistory = events
    .filter(
      (event) =>
        event.action === "complete" ||
        (event.action === "correct" && event.toStatus === "finished"),
    )
    .flatMap((event) => {
      const record = records.find((r) => r.seq === event.recordSeqAtEvent);
      return record ? [{ eventId: event.id, eventSeq: event.seq, record }] : [];
    });
  const lastRecord = records.at(-1) ?? null;
  const targets: contract.TaskDetail["assignmentTargets"] = [];
  if (!ctx.agent) {
    for (const target of db
      .select()
      .from(chat)
      .where(and(eq(chat.projectId, row.projectId), isNull(chat.archivedAt)))
      .all()) {
      try {
        assignmentTarget(target.id, row.projectId, ctx);
        targets.push({
          chatId: target.id,
          kind: target.kind,
          displayTitle: displayTitle(getChat(target.id, ctx)),
          responsibility: taskResponsibilityFacts(target.id, ctx),
        });
      } catch (error) {
        if (!isTaskScopeError(error)) throw error;
        // Omit targets that the current actor cannot assign.
      }
    }
  }
  const activeRunIds = row.chatId
    ? db
        .select({ id: agentRun.id })
        .from(agentRun)
        .where(
          and(eq(agentRun.chatId, row.chatId), inArray(agentRun.status, ["queued", "running"])),
        )
        .all()
        .map((r: { id: string }) => r.id)
    : [];
  return {
    task: {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    chat: current
      ? {
          id: current.id,
          kind: current.kind,
          displayTitle: displayTitle(current),
          archived: !!current.archivedAt,
        }
      : null,
    responsibility,
    checklist: db
      .select()
      .from(taskChecklistItem)
      .where(and(eq(taskChecklistItem.taskId, row.id), isNull(taskChecklistItem.removedAt)))
      .orderBy(asc(taskChecklistItem.position))
      .all()
      .map((item: typeof taskChecklistItem.$inferSelect) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        removedAt: item.removedAt?.toISOString() ?? null,
      })),
    records,
    events,
    lastRecord,
    completionRecord: row.status === "finished" ? lastRecord : null,
    previousCompletionRecord: completionHistory.at(-1)?.record ?? null,
    completionHistory,
    capabilities: taskCapabilityFacts(row, ctx),
    assignmentTargets: targets,
    context: { activeRunIds, relation: "same_chat", taskRunBinding: false },
  };
}
export function getTaskDetail(taskId: string, ctx: ProjectContext): contract.TaskDetail {
  contract.taskIdSchema.parse(taskId);
  return sqlite.transaction(() => readTaskDetail(taskRow(taskId, ctx), ctx))();
}
function summary(detail: contract.TaskDetail): contract.TaskSummary {
  const ref = (record: contract.TaskRecordView) => ({
    messageId: record.visibility === "readable" ? record.messageId : "",
    seq: record.seq,
    chatId: record.chatId,
  });
  return {
    id: detail.task.id,
    projectId: detail.task.projectId,
    status: detail.task.status,
    title: detail.task.title,
    revision: detail.task.revision,
    ...(detail.chat
      ? {
          chatId: detail.chat.id,
          chatKind: detail.chat.kind,
          chatDisplayTitle: detail.chat.displayTitle,
        }
      : {}),
    ...(detail.responsibility ? { responsibility: detail.responsibility } : {}),
    checklist: {
      total: detail.checklist.length,
      checked: detail.checklist.filter((i) => i.checked).length,
    },
    recordCount: detail.records.length,
    ...(detail.lastRecord?.visibility === "readable"
      ? { lastRecordRef: ref(detail.lastRecord) }
      : {}),
    ...(detail.previousCompletionRecord?.visibility === "readable"
      ? { previousCompletionRef: ref(detail.previousCompletionRecord) }
      : {}),
    updatedAt: detail.task.updatedAt,
    allowedActions: detail.capabilities.allowedActions,
  };
}
export function getProjectTasks(projectId: string, ctx: ProjectContext): contract.ProjectTasksView {
  return sqlite.transaction(() => {
    assertProjectAccess(ctx, projectId);
    if (ctx.agent) {
      const scope = readRunScope(ctx.agent.runId);
      if (
        !scope?.active ||
        scope.instanceId !== ctx.agent.instanceId ||
        scope.agentProfileId !== ctx.agent.agentProfileId
      )
        throw new TaskError("not_found", "任务不存在");
      const member = db
        .select({ id: projectMember.agentProfileId })
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, ctx.agent.agentProfileId),
          ),
        )
        .get();
      if (!member) throw new TaskError("not_found", "任务不存在");
      getChat(scope.chatId, ctx);
    }
    const rows = db
      .select()
      .from(task)
      .where(eq(task.projectId, projectId))
      .orderBy(desc(task.updatedAt), asc(task.id))
      .all();
    const items: contract.TaskSummary[] = [];
    for (const row of rows) {
      try {
        assertTaskReadScope(row, ctx);
      } catch (error) {
        if (!isTaskScopeError(error)) throw error;
        continue;
      }
      items.push(summary(readTaskDetail(row, ctx)));
    }
    return { projectId, items };
  })();
}
export function getTasksForChat(chatId: string, ctx: ProjectContext): contract.TaskSummary[] {
  const current = getChat(chatId, ctx);
  return getProjectTasks(current.projectId, ctx).items.filter((item) => item.chatId === chatId);
}

export const createTask = (input: unknown, ctx: ProjectContext) => mutateTask("create", input, ctx);
export const updateTask = (input: unknown, ctx: ProjectContext) => mutateTask("update", input, ctx);
export const assignTask = (input: unknown, ctx: ProjectContext) => mutateTask("assign", input, ctx);
export const reassignTask = (input: unknown, ctx: ProjectContext) =>
  mutateTask("reassign", input, ctx);
export const unassignTask = (input: unknown, ctx: ProjectContext) =>
  mutateTask("unassign", input, ctx);
export const startTask = (input: unknown, ctx: ProjectContext) => mutateTask("start", input, ctx);
export const completeTask = (input: unknown, ctx: ProjectContext) =>
  mutateTask("complete", input, ctx);
export const cancelTask = (input: unknown, ctx: ProjectContext) => mutateTask("cancel", input, ctx);
export const correctTask = (input: unknown, ctx: ProjectContext) =>
  mutateTask("correct", input, ctx);
export const reopenTask = (input: unknown, ctx: ProjectContext) => mutateTask("reopen", input, ctx);
export const addTaskChecklistItem = (input: unknown, ctx: ProjectContext) =>
  mutateTask("checklist_add", input, ctx);
export const updateTaskChecklistItem = (input: unknown, ctx: ProjectContext) =>
  mutateTask("checklist_update", input, ctx);
export const removeTaskChecklistItem = (input: unknown, ctx: ProjectContext) =>
  mutateTask("checklist_remove", input, ctx);
export const appendTaskRecord = (input: unknown, ctx: ProjectContext) =>
  mutateTask("record_append", input, ctx);
