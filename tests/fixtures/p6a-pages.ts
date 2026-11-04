import type { ChatContinuationView } from "../../src/contracts/chat-continuation";
import type { ContinuationDenials } from "../../src/components/continuation/continuation-page-data";

export const p6aIds = {
  project: "prj_aaaaaaaa",
  chat: "cnv_aaaaaaaa",
  task: "tsk_aaaaaaaa",
  run: "run_aaaaaaaa",
  instance: "ins_aaaaaaaa",
  request: "req_aaaaaaaa",
};
export const p6aCases = [
  "idle",
  "scheduled",
  "off",
  "failure",
  "running",
  "unknown",
  "human",
  "denied",
] as const;
export type P6aCase = (typeof p6aCases)[number];
const at = "2026-01-02T03:04:05.000Z";
const later = "2026-01-02T03:09:05.000Z";

/** Explicit typed service read fixtures; no scheduler behavior is implemented here. */
export function continuationFixture(name: P6aCase = "idle"): ChatContinuationView {
  const view: ChatContinuationView = {
    projectId: p6aIds.project,
    chatId: p6aIds.chat,
    mode: "enabled",
    epoch: 1,
    revision: 1,
    owner: { kind: "agent", id: "agp_aaaaaaaa" },
    changedBy: null,
    changedAt: null,
    reason: null,
    assignedTaskIds: [p6aIds.task],
    nextDueAt: null,
    activeRunIds: [],
    remindedHuman: false,
    latestEvaluation: null,
    recentRounds: [],
    deliveries: [],
    attention: null,
  };
  if (name === "scheduled") view.nextDueAt = later;
  if (name === "off") {
    view.mode = "off";
    view.reason = "Human 关闭自动检查，等待确认上下文。";
  }
  if (name === "failure") {
    view.latestEvaluation = {
      evaluationId: "evaluation-failure",
      source: "task_periodic",
      state: "retry_wait",
      round: 1,
      attempt: 1,
      claimedAt: at,
      finishedAt: at,
      evaluatedAt: at,
      nextAttemptAt: later,
      result: null,
      errorCode: "provider_timeout",
      usage: null,
    };
    view.recentRounds = [
      {
        evaluationId: "evaluation-failure",
        round: 1,
        source: "task_periodic",
        state: "retry_wait",
        evaluatedAt: at,
        result: null,
        errorCode: "provider_timeout",
        attempts: [
          {
            attempt: 1,
            startedAt: at,
            finishedAt: at,
            outcome: "retry_wait",
            errorCode: "provider_timeout",
            usage: null,
          },
        ],
      },
    ];
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
/** Page-level diagnostic scenarios add an actual latest round, unlike the empty Hub fixture. */
export function diagnosticFixture(name: P6aCase = "idle"): ChatContinuationView {
  const view = continuationFixture(name);
  if (!view.latestEvaluation) {
    view.latestEvaluation = {
      ...continuationFixture("failure").latestEvaluation!,
      evaluationId: "evaluation-current",
      state: "decided",
      nextAttemptAt: null,
      errorCode: null,
      result: {
        provider: "llm",
        version: "v1",
        decision: "do_not_continue",
        reason: "当前没有需要接续的接收者",
        reasonCode: "no_recipient",
        snapshotHash: "a".repeat(64),
        selectedRecipients: [],
        probability: null,
        errorCode: null,
        recipients: [
          { recipient: view.owner, decision: "no", reason: "没有待续事项", probability: null },
        ],
      },
    };
    view.recentRounds = [
      {
        ...continuationFixture("failure").recentRounds[0],
        evaluationId: view.latestEvaluation.evaluationId,
        state: "decided",
        result: view.latestEvaluation.result,
        errorCode: null,
        attempts: [
          {
            attempt: 1,
            startedAt: at,
            finishedAt: later,
            outcome: "decided",
            errorCode: null,
            usage: null,
          },
        ],
      },
    ];
  }
  if (!view.latestEvaluation) throw new Error("Diagnostic fixture requires a latest evaluation");
  if (name === "running") {
    view.latestEvaluation = {
      ...view.latestEvaluation,
      state: "claimed",
      claimedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: null,
      evaluatedAt: null,
      result: null,
    };
    view.recentRounds[0] = {
      ...view.recentRounds[0],
      state: "claimed",
      evaluatedAt: null,
      result: null,
      attempts: [
        {
          attempt: 1,
          startedAt: view.latestEvaluation.claimedAt!,
          finishedAt: null,
          outcome: null,
          errorCode: null,
          usage: null,
        },
      ],
    };
  }
  view.latestEvaluation = { ...view.latestEvaluation, round: 2 };
  view.recentRounds[0] = { ...view.recentRounds[0], round: 2 };
  view.recentRounds.push({
    evaluationId: "evaluation-history",
    round: 1,
    source: "message",
    state: "canceled",
    evaluatedAt: at,
    result: null,
    errorCode: null,
    attempts: [],
  });
  return view;
}

export function continuationDenials(name: P6aCase): ContinuationDenials {
  return name === "denied"
    ? {
        disable: { code: "forbidden", reason: "当前身份无权关闭此 Chat 的对话接续" },
        abort: { code: "forbidden", reason: "当前身份无权中止此 Chat 的 run" },
      }
    : {};
}
