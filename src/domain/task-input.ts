import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { TaskCommandResult } from "../contracts/task";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentRun,
  agentRunInput,
  chat,
  message,
  project,
  task,
  taskChecklistItem,
} from "../db/schema";
import type { ProjectContext } from "./access";
import { appendTaskStartRunInput } from "./agent-run";
import {
  isTaskScopeError,
  taskResponsibilityFacts,
  TaskError,
  type TaskRow,
} from "./task-capabilities";

export function appendTaskStartRecord(
  row: TaskRow,
  ctx: ProjectContext,
): NonNullable<TaskCommandResult["startDelivery"]> {
  if (!row.chatId || row.status !== "assigned" || ctx.agent)
    throw new TaskError("task_invalid_transition", "只有 Human 可以请求已分配任务开始");
  const responsibility = taskResponsibilityFacts(row.chatId, ctx);
  const current = db.select().from(chat).where(eq(chat.id, row.chatId)).get()!;
  const recipientId =
    responsibility.kind === "human" ? responsibility.userId : responsibility.agentProfileId;
  const last = db
    .select({ seq: sql<number>`coalesce(max(${message.taskRecordSeq}), 0)` })
    .from(message)
    .where(eq(message.taskId, row.id))
    .get()!.seq;
  const messageId = newId(ID_PREFIXES.message);
  const checklist = db
    .select()
    .from(taskChecklistItem)
    .where(and(eq(taskChecklistItem.taskId, row.id), isNull(taskChecklistItem.removedAt)))
    .orderBy(asc(taskChecklistItem.position))
    .all()
    .map(
      (item: typeof taskChecklistItem.$inferSelect) =>
        `- [${item.checked ? "x" : " "}] ${item.body}`,
    )
    .join("\n");
  const body = `已分配并请求立即开始\nTask：${row.id}\n标题：${row.title}\n说明：${row.description}\n约束：${row.constraints}\n完成要求：${row.completionRequirements}\n清单：\n${checklist}\n${responsibility.kind === "human" ? "通知负责人 Human 处理" : `负责人：${responsibility.name}`}。`;
  if (body.length > 8000)
    throw new TaskError("validation_failed", "任务开始快照超过 8000 字符，请缩短目标、要求或清单");
  db.insert(message)
    .values({
      id: messageId,
      chatId: row.chatId,
      senderKind: "human",
      senderId: ctx.userId,
      body,
      taskId: row.id,
      taskProjectId: row.projectId,
      taskRecordSeq: last + 1,
      taskRecordKind: "start",
      taskAssignmentRevision: row.assignmentRevision,
      taskGovernanceRevision: current.governanceRevision,
      taskStartRecipientId: recipientId,
    })
    .run();
  if (responsibility.kind === "human")
    return { messageId, kind: "human_message", recipientKind: "human", recipientId };
  return {
    messageId,
    kind: "agent_input",
    recipientKind: "agent",
    recipientId,
    runId: appendTaskStartRunInput(messageId, ctx),
  };
}

/** Only pending, unattempted starts can be withdrawn at a Task lifecycle boundary. */
export function cancelTaskStartInputs(taskId: string): number {
  return db
    .update(agentRunInput)
    .set({
      disposition: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "task_context_changed",
    })
    .where(
      and(
        eq(agentRunInput.disposition, "pending"),
        isNull(agentRunInput.admittedAt),
        sql`${agentRunInput.messageId} in (select id from message where task_id=${taskId} and task_record_kind='start')`,
      ),
    )
    .run().changes;
}

type Input = Pick<
  typeof agentRunInput.$inferSelect,
  "runId" | "messageId" | "disposition" | "admittedAt"
>;
type Run = Pick<
  typeof agentRun.$inferSelect,
  "id" | "instanceId" | "projectId" | "chatId" | "status"
>;
/** Reads current rows, not a cached Task snapshot supplied by the caller. */
export function validateTaskStartInput(input: Input, run: Run): boolean {
  const stored = db
    .select()
    .from(agentRunInput)
    .where(and(eq(agentRunInput.runId, input.runId), eq(agentRunInput.messageId, input.messageId)))
    .get();
  if (!stored || stored.disposition !== "pending" || stored.admittedAt || input.runId !== run.id)
    return false;
  const actualRun = db.select().from(agentRun).where(eq(agentRun.id, run.id)).get();
  if (
    !actualRun ||
    actualRun.instanceId !== run.instanceId ||
    actualRun.projectId !== run.projectId ||
    actualRun.chatId !== run.chatId ||
    !["queued", "running"].includes(actualRun.status)
  )
    return false;
  const saved = db.select().from(message).where(eq(message.id, input.messageId)).get();
  if (!saved?.taskId || saved.taskRecordKind !== "start") return false;
  const row = db.select().from(task).where(eq(task.id, saved.taskId)).get();
  const current = db.select().from(chat).where(eq(chat.id, run.chatId)).get();
  const instance = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.id, run.instanceId))
    .get();
  if (
    !row ||
    !current ||
    !instance ||
    row.status !== "assigned" ||
    row.chatId !== run.chatId ||
    saved.chatId !== run.chatId ||
    row.projectId !== run.projectId ||
    saved.taskProjectId !== run.projectId ||
    instance.chatId !== run.chatId ||
    instance.projectId !== run.projectId ||
    saved.taskAssignmentRevision !== row.assignmentRevision ||
    saved.taskGovernanceRevision !== current.governanceRevision ||
    saved.taskStartRecipientId !== instance.agentProfileId
  )
    return false;
  const parent = db.select().from(project).where(eq(project.id, row.projectId)).get();
  if (!parent) return false;
  try {
    const responsibility = taskResponsibilityFacts(run.chatId, {
      userId: parent.createdBy,
      requestId: "task-input-validation",
    });
    return (
      responsibility.kind === "agent" && responsibility.agentProfileId === instance.agentProfileId
    );
  } catch (error) {
    if (!isTaskScopeError(error)) throw error;
    return false;
  }
}

/** Host candidate selection can prune obsolete starts without altering ordinary inputs or stopping running runs. */
export function cancelInvalidTaskStartInputs(runId: string): number {
  return sqlite
    .transaction(() => {
      const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
      if (!run) return 0;
      const inputs = db
        .select({ input: agentRunInput })
        .from(agentRunInput)
        .innerJoin(message, eq(message.id, agentRunInput.messageId))
        .where(
          and(
            eq(agentRunInput.runId, runId),
            eq(agentRunInput.disposition, "pending"),
            isNull(agentRunInput.admittedAt),
            eq(message.taskRecordKind, "start"),
          ),
        )
        .all();
      let count = 0;
      for (const { input } of inputs)
        if (!validateTaskStartInput(input, run)) {
          count += db
            .update(agentRunInput)
            .set({
              disposition: "cancelled",
              cancelledAt: new Date(),
              cancelReason: "task_context_changed",
            })
            .where(
              and(
                eq(agentRunInput.runId, runId),
                eq(agentRunInput.messageId, input.messageId),
                eq(agentRunInput.disposition, "pending"),
                isNull(agentRunInput.admittedAt),
              ),
            )
            .run().changes;
        }
      return count;
    })
    .immediate();
}

/** The synchronous send attempt is the linearization point. A returned Promise is awaited by the host, outside SQLite. */
export function admitTaskStartInput<T>(
  runId: string,
  messageId: string,
  send: () => T,
): T | undefined {
  let result: T | undefined;
  let sendError: unknown;
  let failed = false;
  sqlite
    .transaction(() => {
      const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
      const input = db
        .select()
        .from(agentRunInput)
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .get();
      if (!run || !input || input.disposition !== "pending" || input.admittedAt) return;
      if (!validateTaskStartInput(input, run)) {
        cancelInvalidTaskStartInputs(runId);
        return;
      }
      db.update(agentRunInput)
        .set({ admittedAt: new Date() })
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .run();
      // Preserve the attempted boundary even if the synchronous transport throws; never resend blindly.
      try {
        result = send();
      } catch (error) {
        failed = true;
        sendError = error;
      }
    })
    .immediate();
  if (failed) throw sendError;
  return result;
}
