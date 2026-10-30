import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import * as contracts from "../src/contracts";
import { messageSchema, sendMessageInput } from "../src/contracts/chat";
import { infoHubTaskSummarySchema } from "../src/contracts/info-hub";
import { newId, ID_PREFIXES } from "../src/contracts/ids";
import {
  remoteAgentRequestSchema,
  chatGetResponseSchema,
  chatSendResponseSchema,
  taskListResponseSchema,
  taskMutateInputSchema,
} from "../src/contracts/remote";
import { APP_ERROR_CODES } from "../src/contracts/result";
import { TASK_ACTIONS, TASK_CAPABILITIES } from "../src/contracts/task-capabilities";
import * as task from "../src/contracts/task";

const taskId = newId(ID_PREFIXES.task);
const projectId = newId(ID_PREFIXES.project);
const chatId = newId(ID_PREFIXES.chat);
const messageId = newId(ID_PREFIXES.message);
const itemId = newId(ID_PREFIXES.taskChecklistItem);
const write = { taskId, expectedRevision: 1 };
const now = "2026-01-01T00:00:00.000Z";
const commandCases: { name: string; schema: z.ZodType; input: Record<string, unknown> }[] = [
  { name: "create", schema: task.createTaskInputSchema, input: { projectId, title: "任务" } },
  { name: "update", schema: task.updateTaskInputSchema, input: { ...write, title: "更新" } },
  { name: "assign", schema: task.assignTaskInputSchema, input: { ...write, targetChatId: chatId } },
  {
    name: "reassign",
    schema: task.reassignTaskInputSchema,
    input: { ...write, targetChatId: chatId },
  },
  { name: "unassign", schema: task.unassignTaskInputSchema, input: write },
  { name: "start", schema: task.startTaskInputSchema, input: write },
  { name: "complete", schema: task.completeTaskInputSchema, input: write },
  { name: "cancel", schema: task.cancelTaskInputSchema, input: write },
  {
    name: "correct",
    schema: task.correctTaskInputSchema,
    input: { ...write, description: "纠正" },
  },
  { name: "reopen", schema: task.reopenTaskInputSchema, input: write },
  {
    name: "checklist_add",
    schema: task.addTaskChecklistItemInputSchema,
    input: { ...write, body: "步骤" },
  },
  {
    name: "checklist_update",
    schema: task.updateTaskChecklistItemInputSchema,
    input: { ...write, itemId, checked: false },
  },
  {
    name: "checklist_remove",
    schema: task.removeTaskChecklistItemInputSchema,
    input: { ...write, itemId },
  },
  {
    name: "record_append",
    schema: task.appendTaskRecordInputSchema,
    input: { ...write, body: "进展" },
  },
];

describe("Task commands", () => {
  it.each(commandCases)(
    "$name rejects extra keys and accepts its bounded input",
    ({ schema, input, name }) => {
      expect(schema.safeParse(input).success).toBe(true);
      for (const key of ["unknown", "status", "chatId", "actor", "sender", "runId", "instanceId"])
        expect(schema.safeParse({ ...input, [key]: "injected" }).success, `${name}.${key}`).toBe(
          false,
        );
      if (name !== "create") {
        const { expectedRevision: _revision, ...withoutRevision } = input;
        expect(schema.safeParse(withoutRevision).success).toBe(false);
        for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
          expect(schema.safeParse({ ...input, expectedRevision }).success).toBe(false);
      }
    },
  );

  it("keeps nested records and correction patches bounded", () => {
    expect(
      task.completeTaskInputSchema.safeParse({
        ...write,
        appendRecord: { body: "结果", kind: "correction" },
      }).success,
    ).toBe(false);
    expect(
      task.correctTaskInputSchema.safeParse({
        ...write,
        record: { body: "纠正", authorRunId: "forged" },
      }).success,
    ).toBe(false);
    for (const checklist of [
      { add: [{ body: "步骤", checked: true }] },
      { update: [{ itemId }] },
      { update: [{ itemId, checked: true, position: 2 }] },
      { removeIds: [itemId], reorder: [] },
    ])
      expect(task.correctTaskInputSchema.safeParse({ ...write, checklist }).success).toBe(false);
    expect(
      task.correctTaskInputSchema.safeParse({
        ...write,
        checklist: {
          add: [{ body: "步骤" }],
          update: [{ itemId, checked: false }],
          removeIds: [itemId],
        },
        record: { body: "纠正", referenceMessageId: messageId },
      }).success,
    ).toBe(true);
    expect(task.updateTaskChecklistItemInputSchema.safeParse({ ...write, itemId }).success).toBe(
      false,
    );
    expect(task.reopenTaskInputSchema.safeParse({ ...write, startNow: true }).success).toBe(false);
    expect(task.assignTaskInputSchema.parse({ ...write, targetChatId: chatId }).startNow).toBe(
      false,
    );
  });

  it("enforces the frozen text limits without silently truncating", () => {
    const create = task.createTaskInputSchema;
    expect(create.parse({ projectId, title: " 标题 " }).title).toBe("标题");
    expect(
      create.safeParse({ projectId, title: "x".repeat(120), description: "x".repeat(8000) })
        .success,
    ).toBe(true);
    for (const input of [
      { title: " " },
      { title: "x".repeat(121) },
      { description: "x".repeat(8001) },
      { constraints: "x".repeat(8001) },
      { completionRequirements: "x".repeat(8001) },
      { checklist: ["x".repeat(1001)] },
      { checklist: [" "] },
    ])
      expect(create.safeParse({ projectId, title: "标题", ...input }).success).toBe(false);
    expect(task.appendTaskRecordInputSchema.safeParse({ ...write, body: " " }).success).toBe(false);
    expect(
      task.appendTaskRecordInputSchema.safeParse({ ...write, body: "x".repeat(8001) }).success,
    ).toBe(false);
  });
});

describe("Task closed sets", () => {
  it("accepts exactly four statuses", () => {
    expect(task.TASK_STATUSES).toEqual(["proposed", "assigned", "finished", "canceled"]);
    for (const status of task.TASK_STATUSES)
      expect(task.taskStatusSchema.parse(status)).toBe(status);
    for (const status of ["running", "started", "accepted", "completed", "cancelled", "", null])
      expect(task.taskStatusSchema.safeParse(status).success).toBe(false);
  });

  it("has one capability row per action and only the five access levels", () => {
    expect(new Set(Object.keys(TASK_CAPABILITIES))).toEqual(new Set(TASK_ACTIONS));
    expect(new Set(TASK_ACTIONS).size).toBe(TASK_ACTIONS.length);
    const levels = new Set(["never", "project", "member", "responsible", "human"]);
    for (const row of Object.values(TASK_CAPABILITIES)) {
      expect(Object.keys(row).sort()).toEqual(["agent", "human"]);
      for (const level of Object.values(row)) expect(levels.has(level)).toBe(true);
    }
    expect(TASK_CAPABILITIES.create.human).toBe("project");
    for (const action of [
      "create",
      "assign",
      "reassign",
      "unassign",
      "start",
      "correct",
      "reopen",
    ] as const)
      expect(TASK_CAPABILITIES[action].agent).toBe("never");
    for (const action of ["update", "complete", "cancel"] as const)
      expect(TASK_CAPABILITIES[action].agent).toBe("responsible");
    for (const action of [
      "checklist_add",
      "checklist_update",
      "checklist_remove",
      "record_append",
    ] as const)
      expect(TASK_CAPABILITIES[action].agent).toBe("member");
  });

  it("registers the five business errors and public exports", () => {
    for (const code of [
      "task_invalid_transition",
      "task_assignment_invalid",
      "task_record_required",
      "task_reference_forbidden",
      "task_record_immutable",
    ])
      expect(APP_ERROR_CODES).toContain(code);
    expect(contracts.taskDetailSchema).toBe(task.taskDetailSchema);
    expect(contracts.TASK_CAPABILITIES).toBe(TASK_CAPABILITIES);
  });
});

it("keeps restricted references free of record content and author identity", () => {
  const restricted = { taskId, seq: 1, chatId, visibility: "restricted" };
  expect(task.taskRecordViewSchema.parse(restricted)).toEqual(restricted);
  for (const key of [
    "messageId",
    "body",
    "senderId",
    "senderKind",
    "kind",
    "authorRunId",
    "referenceMessageId",
    "createdAt",
  ])
    expect(task.taskRecordViewSchema.safeParse({ ...restricted, [key]: "secret" }).success).toBe(
      false,
    );
  const readable = {
    taskId,
    seq: 1,
    chatId,
    visibility: "readable",
    messageId,
    kind: "progress",
    senderKind: "human",
    senderId: "user",
    body: "进展",
    createdAt: now,
  };
  expect(task.taskRecordViewSchema.safeParse(readable).success).toBe(true);
  expect(task.taskRecordViewSchema.safeParse({ ...readable, visibility: "hidden" }).success).toBe(
    false,
  );
  const { body: _body, ...withoutBody } = readable;
  expect(task.taskRecordViewSchema.safeParse(withoutBody).success).toBe(false);
});

const remoteCalls = [
  { type: "task_get", input: { projectId, taskId } },
  { type: "task_list", input: { projectId } },
  { type: "task_mutate", input: { projectId, ...write, action: "update", title: "更新" } },
  { type: "chat_get", input: { projectId } },
  { type: "chat_send", input: { projectId, body: "消息" } },
];

it.each(remoteCalls)(
  "remote $type rejects client supplied identity and chat scope",
  ({ type, input }) => {
    expect(remoteAgentRequestSchema.safeParse({ version: 2, call: { type, input } }).success).toBe(
      true,
    );
    for (const key of [
      "sender",
      "senderKind",
      "senderId",
      "actor",
      "runId",
      "instanceId",
      "chatId",
    ])
      expect(
        remoteAgentRequestSchema.safeParse({
          version: 2,
          call: { type, input: { ...input, [key]: "forged" } },
        }).success,
      ).toBe(false);
  },
);

it("exposes only the seven Agent mutations and eleven frozen tools", () => {
  const mutations = commandCases.filter(({ name }) =>
    [
      "update",
      "checklist_add",
      "checklist_update",
      "checklist_remove",
      "record_append",
      "complete",
      "cancel",
    ].includes(name),
  );
  for (const { name, input } of mutations)
    expect(taskMutateInputSchema.safeParse({ projectId, action: name, ...input }).success).toBe(
      true,
    );
  for (const action of ["create", "assign", "reassign", "unassign", "start", "correct", "reopen"])
    expect(taskMutateInputSchema.safeParse({ projectId, ...write, action }).success).toBe(false);
  expect(
    taskMutateInputSchema.safeParse({ projectId, ...write, action: "checklist_update", itemId })
      .success,
  ).toBe(false);
  expect(Object.keys(task.taskToolInputSchemas).sort()).toEqual(
    [
      "sprout_task_list",
      "sprout_task_get",
      "sprout_task_update",
      "sprout_task_checklist_add",
      "sprout_task_checklist_update",
      "sprout_task_checklist_remove",
      "sprout_task_record_append",
      "sprout_task_complete",
      "sprout_task_cancel",
      "sprout_chat_get",
      "sprout_chat_send",
    ].sort(),
  );
  for (const [name, schema] of Object.entries(task.taskToolInputSchemas)) {
    const commandName = name.replace("sprout_task_", "");
    const input =
      name === "sprout_task_get"
        ? { taskId }
        : name === "sprout_chat_send"
          ? { body: "消息" }
          : (commandCases.find((item) => item.name === commandName)?.input ?? {});
    expect(schema.safeParse(input).success, name).toBe(true);
    for (const key of ["sender", "actor", "runId", "instanceId", "projectId", "chatId"])
      expect(schema.safeParse({ ...input, [key]: "forged" }).success, `${name}.${key}`).toBe(false);
  }
});

it("keeps the Info Hub Task summary limited to the frozen metadata fields", () => {
  const summary = {
    taskId,
    title: "标题",
    status: "proposed",
    revision: 1,
    checklistTotal: 0,
    checklistChecked: 0,
    recordCount: 0,
    updatedAt: now,
    context: { activeRunIds: [], relation: "same_chat", taskRunBinding: false },
  };
  expect(infoHubTaskSummarySchema.parse(summary)).toEqual(summary);
  expect(Object.keys(infoHubTaskSummarySchema.shape).sort()).toEqual(
    [
      "taskId",
      "title",
      "status",
      "revision",
      "chatId",
      "chatKind",
      "chatDisplayTitle",
      "responsibility",
      "checklistTotal",
      "checklistChecked",
      "recordCount",
      "lastRecordRef",
      "previousCompletionRef",
      "updatedAt",
      "context",
    ].sort(),
  );
  for (const key of [
    "description",
    "constraints",
    "completionRequirements",
    "requirements",
    "body",
    "runStatus",
    "leaseId",
  ])
    expect(infoHubTaskSummarySchema.safeParse({ ...summary, [key]: "secret" }).success).toBe(false);
  expect(
    infoHubTaskSummarySchema.safeParse({
      ...summary,
      lastRecordRef: { messageId, chatId, seq: 1, body: "secret" },
    }).success,
  ).toBe(false);
});

it("makes Task metadata optional on message output without adding it to send input", () => {
  const message = {
    id: messageId,
    chatId,
    senderKind: "human",
    senderId: "user",
    body: "消息",
    createdAt: now,
  };
  expect(messageSchema.parse(message)).toEqual(message);
  const metadata = { taskId, seq: 1, kind: "progress" };
  expect(messageSchema.parse({ ...message, taskRecord: metadata }).taskRecord).toEqual(metadata);
  expect(sendMessageInput.parse({ ...message, taskRecord: metadata })).not.toHaveProperty(
    "taskRecord",
  );
  expect(
    messageSchema.safeParse({
      ...message,
      taskRecord: { ...metadata, seq: Number.MAX_SAFE_INTEGER + 1 },
    }).success,
  ).toBe(false);
});

it("validates remote list and Chat outputs against their response schemas", () => {
  expect(taskListResponseSchema.parse({ projectId, chatId, items: [] })).toEqual({
    projectId,
    chatId,
    items: [],
  });
  expect(taskListResponseSchema.safeParse({ projectId, items: [] }).success).toBe(false);
  const message = {
    id: messageId,
    chatId,
    senderKind: "human",
    senderId: "user",
    body: "消息",
    createdAt: now,
  };
  expect(chatSendResponseSchema.safeParse({ projectId, chatId, message }).success).toBe(true);
  expect(
    chatSendResponseSchema.safeParse({ projectId, chatId: newId(ID_PREFIXES.chat), message })
      .success,
  ).toBe(false);
  const session = {
    kind: "group",
    chat: {
      id: chatId,
      projectId,
      kind: "group",
      owner: { kind: "human", id: "user" },
      wakePolicy: "owner_led",
      governanceRevision: 0,
      createdBy: "user",
      createdAt: now,
      updatedAt: now,
    },
    members: [],
    instances: [],
    governance: {
      ownerKind: "human",
      ownerId: "user",
      actorKind: "human",
      actorId: "user",
      canChangeMembers: true,
      canChangeOwner: true,
      canChangeWakePolicy: true,
      canRenameTitle: true,
    },
  };
  const chatResponse = { projectId, chatId, session, messages: [message] };
  expect(chatGetResponseSchema.safeParse(chatResponse).success).toBe(true);
  expect(
    chatGetResponseSchema.safeParse({ ...chatResponse, projectId: newId(ID_PREFIXES.project) })
      .success,
  ).toBe(false);
  expect(
    chatGetResponseSchema.safeParse({
      ...chatResponse,
      messages: [{ ...message, chatId: newId(ID_PREFIXES.chat) }],
    }).success,
  ).toBe(false);
  const summary = {
    id: taskId,
    projectId,
    chatId,
    title: "标题",
    status: "assigned",
    revision: 1,
    checklist: { total: 0, checked: 0 },
    recordCount: 0,
    updatedAt: now,
    allowedActions: [],
  };
  expect(taskListResponseSchema.safeParse({ projectId, chatId, items: [summary] }).success).toBe(
    true,
  );
  for (const wrongScope of [
    { projectId: newId(ID_PREFIXES.project) },
    { chatId: newId(ID_PREFIXES.chat) },
  ])
    expect(
      taskListResponseSchema.safeParse({
        projectId,
        chatId,
        items: [{ ...summary, ...wrongScope }],
      }).success,
    ).toBe(false);
});
