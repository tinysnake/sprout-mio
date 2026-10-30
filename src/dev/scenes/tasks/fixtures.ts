import type { ProjectTasksView, TaskDetail, TaskSummary } from "../../../contracts/task";
import { TASK_STATUSES } from "../../../contracts/task";

export const taskSceneProjectId = "prj_11111111-1111-4111-8111-111111111111";
const chatId = "cnv_22222222-2222-4222-8222-222222222222";
const time = "2026-06-20T09:00:00.000Z";
const taskId = "tsk_33333333-3333-4333-8333-333333333333";
const record = { taskId, seq: 1, chatId, messageId: "msg_44444444-4444-4444-8444-444444444444", visibility: "readable" as const, kind: "progress" as const, senderKind: "agent" as const, senderId: "agent-demo", body: "已核对实现与验证证据。", createdAt: time };
export const taskSceneDetail: TaskDetail = {
  task: { id: taskId, projectId: taskSceneProjectId, chatId, status: "assigned", title: "核对 Task 页面与协作事实", description: "按顺序阅读目标、要求和施工记录。", constraints: "分配、run 与租约分别呈现。", completionRequirements: "真实页面可操作并保留历史结果。", revision: 3, assignmentRevision: 1, createdBy: "human-demo", createdAt: time, updatedAt: time },
  chat: { id: chatId, kind: "dm", displayTitle: "页面实现", archived: false },
  responsibility: { kind: "human", userId: "human-demo" },
  checklist: [{ id: "tci_55555555-5555-4555-8555-555555555555", taskId, position: 1, body: "核对 390 宽布局", checked: false, removedAt: null, createdAt: time, updatedAt: time }],
  records: [record], events: [], lastRecord: record, completionRecord: null, previousCompletionRecord: record,
  completionHistory: [{ eventId: "tev_66666666-6666-4666-8666-666666666666", eventSeq: 2, record }],
  capabilities: { allowedActions: ["complete", "cancel", "correct", "reassign", "record_append", "checklist_update", "checklist_add", "checklist_remove"], denials: { reopen: { code: "task_invalid_transition", reason: "当前状态不允许重开" } } },
  assignmentTargets: [{ chatId, kind: "dm", displayTitle: "页面实现", responsibility: { kind: "human", userId: "human-demo" } }],
  context: { activeRunIds: [], relation: "same_chat", taskRunBinding: false },
};
const base: TaskSummary = { id: taskId, projectId: taskSceneProjectId, status: "assigned", title: taskSceneDetail.task.title, revision: 3, chatId, chatKind: "dm", chatDisplayTitle: "页面实现", responsibility: taskSceneDetail.responsibility ?? undefined, checklist: { total: 1, checked: 0 }, recordCount: 1, updatedAt: time, allowedActions: [] };
export const taskSceneBoard: ProjectTasksView = { projectId: taskSceneProjectId, items: TASK_STATUSES.map((status, index) => ({ ...base, id: `tsk_${index}3333333-3333-4333-8333-333333333333`, status, title: status === "proposed" ? "核对边界与证据".repeat(16) : base.title, ...(status === "finished" ? { lastRecordRef: { messageId: record.messageId, seq: 1, chatId } } : {}), ...(status === "assigned" ? { previousCompletionRef: { messageId: record.messageId, seq: 1, chatId } } : {}) })) };
