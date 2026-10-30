import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { chatKindSchema } from "./chat";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { APP_ERROR_CODES, type AppResult } from "./result";
import { TASK_ACTIONS } from "./task-capabilities";
import type { FieldErrors } from "./project";

const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));
export const taskIdSchema = id(ID_PREFIXES.task);
const projectId = id(ID_PREFIXES.project);
const chatId = id(ID_PREFIXES.chat);
const messageId = id(ID_PREFIXES.message);
const runId = id(ID_PREFIXES.run);
const itemId = id(ID_PREFIXES.taskChecklistItem);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = nonnegativeInteger.min(1);
const title = z.string().trim().min(1).max(120);
const text = z.string().max(8000);
const checklistBody = z.string().trim().min(1).max(1000);
const recordBody = z.string().trim().min(1).max(8000);

export const TASK_STATUSES = ["proposed", "assigned", "finished", "canceled"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const TASK_RECORD_KINDS = ["start", "progress", "correction"] as const;
export const taskRecordKindSchema = z.enum(TASK_RECORD_KINDS);
export type TaskRecordKind = z.infer<typeof taskRecordKindSchema>;

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  projectId,
  chatId: chatId.nullable(),
  status: taskStatusSchema,
  title,
  description: text,
  constraints: text,
  completionRequirements: text,
  revision: positiveInteger,
  assignmentRevision: nonnegativeInteger,
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskChecklistItemSchema = z.strictObject({
  id: itemId,
  taskId: taskIdSchema,
  position: positiveInteger,
  body: checklistBody,
  checked: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(),
});
export type TaskChecklistItem = z.infer<typeof taskChecklistItemSchema>;

export const taskRecordSchema = z.strictObject({
  messageId,
  taskId: taskIdSchema,
  seq: positiveInteger,
  chatId,
  kind: taskRecordKindSchema,
  senderKind: z.enum(["human", "agent"]),
  senderId: z.string().min(1),
  body: recordBody,
  referenceMessageId: messageId.optional(),
  authorRunId: runId.optional(),
  createdAt: z.iso.datetime(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export const taskRecordViewSchema = z.discriminatedUnion("visibility", [
  taskRecordSchema.extend({ visibility: z.literal("readable") }),
  z.strictObject({
    taskId: taskIdSchema,
    seq: positiveInteger,
    chatId,
    visibility: z.literal("restricted"),
  }),
]);
export type TaskRecordView = z.infer<typeof taskRecordViewSchema>;

export const taskEventSchema = z.strictObject({
  id: id(ID_PREFIXES.taskEvent),
  taskId: taskIdSchema,
  projectId,
  seq: positiveInteger,
  action: z.enum(TASK_ACTIONS),
  actorKind: z.enum(["human", "agent"]),
  actorId: z.string().trim().min(1),
  actorRunId: runId.nullable(),
  fromStatus: taskStatusSchema.nullable(),
  toStatus: taskStatusSchema,
  fromChatId: chatId.nullable(),
  toChatId: chatId.nullable(),
  recordSeqAtEvent: positiveInteger.nullable(),
  checklistItemId: itemId.nullable(),
  createdAt: z.iso.datetime(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskResponsibilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), userId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("agent"),
    agentProfileId: agentProfileIdSchema,
    name: z.string(),
    instanceId: id(ID_PREFIXES.instance).nullable(),
  }),
]);
export type TaskResponsibility = z.infer<typeof taskResponsibilitySchema>;

export const taskCapabilityFactsSchema = z.strictObject({
  allowedActions: z.array(z.enum(TASK_ACTIONS)),
  denials: z.partialRecord(
    z.enum(TASK_ACTIONS),
    z.strictObject({ code: z.enum(APP_ERROR_CODES), reason: z.string().min(1) }),
  ),
});
export type TaskCapabilityFacts = z.infer<typeof taskCapabilityFactsSchema>;

export const taskRecordRefSchema = z.strictObject({ messageId, seq: positiveInteger, chatId });
export type TaskRecordRef = z.infer<typeof taskRecordRefSchema>;
export const taskContextSchema = z.strictObject({
  activeRunIds: z.array(runId),
  relation: z.literal("same_chat"),
  taskRunBinding: z.literal(false),
});
export type TaskContext = z.infer<typeof taskContextSchema>;
export const taskSummarySchema = z.strictObject({
  id: taskIdSchema,
  projectId,
  status: taskStatusSchema,
  title,
  revision: positiveInteger,
  chatId: chatId.optional(),
  chatKind: chatKindSchema.optional(),
  chatDisplayTitle: z.string().optional(),
  responsibility: taskResponsibilitySchema.optional(),
  checklist: z.strictObject({ total: nonnegativeInteger, checked: nonnegativeInteger }),
  recordCount: nonnegativeInteger,
  lastRecordRef: taskRecordRefSchema.optional(),
  previousCompletionRef: taskRecordRefSchema.optional(),
  updatedAt: z.iso.datetime(),
  allowedActions: z.array(z.enum(TASK_ACTIONS)),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskDetailSchema = z.strictObject({
  task: taskSchema,
  chat: z
    .strictObject({
      id: chatId,
      kind: chatKindSchema,
      displayTitle: z.string(),
      archived: z.boolean(),
    })
    .nullable(),
  responsibility: taskResponsibilitySchema.nullable(),
  checklist: z.array(taskChecklistItemSchema),
  records: z.array(taskRecordViewSchema),
  events: z.array(taskEventSchema),
  lastRecord: taskRecordViewSchema.nullable(),
  completionRecord: taskRecordViewSchema.nullable(),
  previousCompletionRecord: taskRecordViewSchema.nullable(),
  completionHistory: z.array(
    z.strictObject({
      eventId: id(ID_PREFIXES.taskEvent),
      eventSeq: positiveInteger,
      record: taskRecordViewSchema,
    }),
  ),
  capabilities: taskCapabilityFactsSchema,
  assignmentTargets: z.array(
    z.strictObject({
      chatId,
      kind: chatKindSchema,
      displayTitle: z.string(),
      responsibility: taskResponsibilitySchema,
    }),
  ),
  context: taskContextSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export const projectTasksViewSchema = z.strictObject({
  projectId,
  items: z.array(taskSummarySchema),
});
export type ProjectTasksView = z.infer<typeof projectTasksViewSchema>;

const metadata = { title, description: text, constraints: text, completionRequirements: text };
const metadataPatch = {
  title: title.optional(),
  description: text.optional(),
  constraints: text.optional(),
  completionRequirements: text.optional(),
};
const taskWrite = { taskId: taskIdSchema, expectedRevision: positiveInteger };
const recordInputSchema = z.strictObject({
  body: recordBody,
  referenceMessageId: messageId.optional(),
});
const checklistUpdateFields = {
  itemId,
  body: checklistBody.optional(),
  checked: z.boolean().optional(),
};
const hasChecklistUpdate = (value: { body?: string; checked?: boolean }) =>
  value.body !== undefined || value.checked !== undefined;
const checklistUpdateSchema = z.strictObject(checklistUpdateFields).refine(hasChecklistUpdate, {
  message: "清单更新至少包含 body 或 checked",
});

export const createTaskInputSchema = z.strictObject({
  projectId,
  ...metadata,
  description: text.default(""),
  constraints: text.default(""),
  completionRequirements: text.default(""),
  checklist: z.array(checklistBody).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export const updateTaskInputSchema = z.strictObject({ ...taskWrite, ...metadataPatch });
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export const assignTaskInputSchema = z.strictObject({
  ...taskWrite,
  targetChatId: chatId,
  startNow: z.boolean().default(false),
});
export type AssignTaskInput = z.infer<typeof assignTaskInputSchema>;
export const reassignTaskInputSchema = assignTaskInputSchema;
export type ReassignTaskInput = z.infer<typeof reassignTaskInputSchema>;
export const unassignTaskInputSchema = z.strictObject(taskWrite);
export type UnassignTaskInput = z.infer<typeof unassignTaskInputSchema>;
export const startTaskInputSchema = z.strictObject(taskWrite);
export type StartTaskInput = z.infer<typeof startTaskInputSchema>;
export const completeTaskInputSchema = z.strictObject({
  ...taskWrite,
  appendRecord: recordInputSchema.optional(),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;
export const cancelTaskInputSchema = z.strictObject(taskWrite);
export type CancelTaskInput = z.infer<typeof cancelTaskInputSchema>;
export const correctTaskInputSchema = z.strictObject({
  ...taskWrite,
  ...metadataPatch,
  checklist: z
    .strictObject({
      add: z.array(z.strictObject({ body: checklistBody })).optional(),
      update: z.array(checklistUpdateSchema).optional(),
      removeIds: z.array(itemId).optional(),
    })
    .optional(),
  record: recordInputSchema.optional(),
});
export type CorrectTaskInput = z.infer<typeof correctTaskInputSchema>;
export const reopenTaskInputSchema = z.strictObject({
  ...taskWrite,
  initialChatId: chatId.optional(),
});
export type ReopenTaskInput = z.infer<typeof reopenTaskInputSchema>;
export const addTaskChecklistItemInputSchema = z.strictObject({
  ...taskWrite,
  body: checklistBody,
});
export type AddTaskChecklistItemInput = z.infer<typeof addTaskChecklistItemInputSchema>;
export const updateTaskChecklistItemInputSchema = z
  .strictObject({
    ...taskWrite,
    ...checklistUpdateFields,
  })
  .refine(hasChecklistUpdate, { message: "清单更新至少包含 body 或 checked" });
export type UpdateTaskChecklistItemInput = z.infer<typeof updateTaskChecklistItemInputSchema>;
export const removeTaskChecklistItemInputSchema = z.strictObject({ ...taskWrite, itemId });
export type RemoveTaskChecklistItemInput = z.infer<typeof removeTaskChecklistItemInputSchema>;
export const appendTaskRecordInputSchema = z.strictObject({
  ...taskWrite,
  ...recordInputSchema.shape,
});
export type AppendTaskRecordInput = z.infer<typeof appendTaskRecordInputSchema>;

export const taskCommandResultSchema = z.strictObject({
  detail: taskDetailSchema,
  startDelivery: z
    .strictObject({
      messageId,
      kind: z.enum(["agent_input", "human_message"]),
      recipientKind: z.enum(["agent", "human"]),
      recipientId: z.string().min(1),
      runId: runId.optional(),
    })
    .optional(),
});
export type TaskCommandResult = z.infer<typeof taskCommandResultSchema>;
export type TaskResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };

export const taskToolInputSchemas = {
  sprout_task_list: z.strictObject({}),
  sprout_task_get: z.strictObject({ taskId: taskIdSchema }),
  sprout_task_update: updateTaskInputSchema,
  sprout_task_checklist_add: addTaskChecklistItemInputSchema,
  sprout_task_checklist_update: updateTaskChecklistItemInputSchema,
  sprout_task_checklist_remove: removeTaskChecklistItemInputSchema,
  sprout_task_record_append: appendTaskRecordInputSchema,
  sprout_task_complete: completeTaskInputSchema,
  sprout_task_cancel: cancelTaskInputSchema,
  sprout_chat_get: z.strictObject({}),
  sprout_chat_send: z.strictObject({ body: recordBody }),
};
