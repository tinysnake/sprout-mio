import type { ChatAutomationView } from "../../src/contracts/chat-automation";
import type { AutomationDenials } from "../../src/components/automation/automation-page-data";

export const p6aIds = {
  project: "prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  chat: "cnv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  task: "tsk_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  run: "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  instance: "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  request: "req_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
export const p6aCases = [
  "idle",
  "scheduled",
  "paused",
  "stopped",
  "failure",
  "unknown",
  "human",
  "denied",
] as const;
export type P6aCase = (typeof p6aCases)[number];
const at = "2026-01-02T03:04:05.000Z";
const later = "2026-01-02T03:09:05.000Z";

/** Explicit typed service read fixtures; no scheduler behavior is implemented here. */
export function automationFixture(name: P6aCase = "idle"): ChatAutomationView {
  const view: ChatAutomationView = {
    projectId: p6aIds.project,
    chatId: p6aIds.chat,
    mode: "enabled",
    epoch: 1,
    revision: 1,
    owner: { kind: "agent", id: "agp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    changedBy: null,
    changedAt: null,
    reason: null,
    assignedTaskIds: [p6aIds.task],
    nextDueAt: null,
    activeRunIds: [],
    remindedHuman: false,
    latestEvaluation: null,
    deliveries: [],
    attention: null,
  };
  if (name === "scheduled") view.nextDueAt = later;
  if (name === "paused" || name === "stopped") {
    view.mode = name;
    view.reason = "Human 暂停推进，等待确认上下文。";
  }
  if (name === "failure") {
    view.latestEvaluation = {
      evaluationId: "evaluation-failure",
      source: "task_periodic",
      state: "retry_wait",
      round: 1,
      attempt: 1,
      evaluatedAt: at,
      nextAttemptAt: later,
      result: null,
      errorCode: "provider_timeout",
    };
    view.attention = {
      errorCode: "provider_timeout",
      reason: "判定器超时，正在退避等待重试。",
      requestId: p6aIds.request,
      evaluationId: "evaluation-failure",
      deliveryId: null,
    };
  }
  if (name === "unknown") {
    view.activeRunIds = [p6aIds.run];
    view.deliveries = [
      {
        deliveryId: "delivery-unknown",
        evaluationId: "evaluation-unknown",
        projectId: view.projectId,
        chatId: view.chatId,
        recipient: { kind: "agent", id: view.owner.id },
        instanceId: p6aIds.instance,
        runId: p6aIds.run,
        controlEpoch: 1,
        snapshotHash: "a".repeat(64),
        state: "attention",
        attempt: 1,
        taskIds: [p6aIds.task],
        createdAt: at,
        admittedAt: at,
        deliveredAt: null,
        presentedAt: null,
        nextAttemptAt: null,
        cancelReason: null,
        errorCode: "delivery_unknown",
        supersedesDeliveryId: null,
      },
    ];
    view.attention = {
      errorCode: "delivery_unknown",
      reason: "未收到接续输入确认，请核实当前 run。",
      requestId: p6aIds.request,
      evaluationId: "evaluation-unknown",
      deliveryId: "delivery-unknown",
    };
  }
  if (name === "human") {
    view.owner = { kind: "human", id: "human-owner" };
    view.remindedHuman = true;
  }
  return view;
}
export function automationDenials(name: P6aCase): AutomationDenials {
  return name === "denied"
    ? {
        pause: { code: "forbidden", reason: "当前身份无权暂停此 Chat" },
        stop: { code: "forbidden", reason: "当前身份无权停止此 Chat" },
      }
    : {};
}
