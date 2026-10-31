import { describe, expect, it } from "vite-plus/test";
import {
  APP_ERROR_CODES,
  CHAT_AUTOMATION_ACTIONS,
  CHAT_AUTOMATION_CAPABILITIES,
  CHAT_AUTOMATION_POLICY,
  ID_PREFIXES,
  WAKE_CONTEXT_LIMITS,
  chatAutomationCommandSchema,
  chatAutomationErrorCodeSchema,
  chatAutomationEvaluationViewSchema,
  chatAutomationGetCall,
  chatAutomationGetInputSchema,
  chatAutomationGetResponseSchema,
  chatAutomationModeSchema,
  chatAutomationSummarySchema,
  chatAutomationViewSchema,
  chatInfoViewSchema,
  chatRunAggregateSchema,
  continuationCancelReasonSchema,
  continuationDeliverySchema,
  continuationDeliveryStateSchema,
  continuationInputEnvelopeSchema,
  projectSchema,
  projectWakePolicySchema,
  remoteToolInputSchemas,
  toAppError,
  updateProjectWakePolicyInputSchema,
  wakeEvaluationErrorCodeSchema,
  wakeEvaluationInputSchema,
  wakeEvaluationResultSchema,
  wakeEvaluationResultForInputSchema,
  wakeEvaluationSourceSchema,
  wakeProviderAvailabilitySchema,
  wakeProviderSchema,
  wakeRecipientDecisionSchema,
} from "../src/contracts";
import { remoteAgentRequestSchema } from "../src/contracts/remote";

const uuid = "00000000-0000-4000-8000-000000000001";
const projectId = `prj_${uuid}`;
const chatId = `${ID_PREFIXES.chat}_${uuid}`;
const instanceId = `${ID_PREFIXES.instance}_${uuid}`;
const runId = `run_${uuid}`;
const taskId = `${ID_PREFIXES.task}_${uuid}`;
const requestId = `req_${uuid}`;
const messageId = `msg_${uuid}`;
const agent = { kind: "agent", id: `${ID_PREFIXES.agentProfile}_${uuid}` };
const human = { kind: "human", id: "human-owner" };
const at = "2026-11-01T00:00:00.000Z";
const snapshotHash = "a".repeat(64);
const policy = {
  provider: "small_brain",
  configRevision: 1,
  model: "fixed-model",
  thresholdVersion: "v1",
};
const message = (body = "继续核对契约。", index = 1) => ({
  id: `msg_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  kind: "human",
  sender: human,
  body,
  createdAt: at,
  truncated: false,
});
const candidate = () => ({
  recipient: agent,
  instanceId,
  personaSummary: "契约维护者",
  responsibility: "核对接口",
  activeRun: null,
  latestRun: null,
  externalWork: [],
});
const task = () => ({
  id: taskId,
  title: "冻结契约",
  status: "assigned",
  revision: 1,
  assignmentRevision: 1,
  chatId,
  responsibility: agent,
  checklistTotal: 2,
  checklistChecked: 1,
  recordCount: 0,
  lastRecord: null,
  previousCompletionRef: null,
});
const input = (recentMessages: ReturnType<typeof message>[] = []) => ({
  source: "task_periodic",
  projectId,
  chatId,
  triggerId: "schedule-1",
  round: 1,
  controlEpoch: 1,
  policy,
  evaluatedAt: at,
  triggerMessage: null,
  latestReadableMessageId: null,
  recentMessages,
  chat: {
    kind: "group",
    goal: "完成 P6a",
    collaboration: "中文协作",
    owner: agent,
    wakePolicy: "contextual",
    governanceRevision: 1,
  },
  candidates: [candidate()],
  tasks: [task()],
  truncation: {
    originalMessageCount: recentMessages.length,
    includedMessageCount: recentMessages.length,
    droppedMessageIdRange: null,
    tasksComplete: true,
    candidatesComplete: true,
    recentMessageCharacters: recentMessages.reduce(
      (sum, item) => sum + Array.from(item.body).length,
      0,
    ),
    characterBudget: 24000,
  },
  snapshotHash,
});
const result = () => ({
  decision: "continue",
  reason: "负责人需要继续核对",
  reasonCode: "work_remaining",
  recipients: [{ recipient: agent, decision: "yes", reason: "尚有工作", probability: 0.9 }],
  selectedRecipients: [agent],
  probability: null,
  provider: "small_brain",
  model: "fixed-model",
  version: "v1",
  snapshotHash,
  errorCode: null,
});
const delivery = () => ({
  deliveryId: "delivery-1",
  evaluationId: "evaluation-1",
  projectId,
  chatId,
  recipient: agent,
  instanceId,
  runId: null,
  controlEpoch: 1,
  snapshotHash,
  state: "pending",
  attempt: 0,
  taskIds: [taskId],
  createdAt: at,
  admittedAt: null,
  deliveredAt: null,
  presentedAt: null,
  nextAttemptAt: null,
  cancelReason: null,
  errorCode: null,
  supersedesDeliveryId: null,
});
const envelope = () => ({
  kind: "continuation",
  deliveryId: "delivery-1",
  evaluationId: "evaluation-1",
  projectId,
  chatId,
  runId,
  instanceId,
  controlEpoch: 1,
  snapshotHash,
  source: "task_periodic",
  taskIds: [taskId],
  recordRefs: [],
  body: "请继续核对当前 assigned Task。",
  supersedesDeliveryId: null,
});
const view = () => ({
  projectId,
  chatId,
  mode: "enabled",
  epoch: 1,
  revision: 1,
  owner: agent,
  changedBy: null,
  changedAt: null,
  reason: null,
  assignedTaskIds: [taskId],
  nextDueAt: "2026-11-01T00:05:00.000Z",
  activeRunIds: [],
  remindedHuman: false,
  latestEvaluation: null,
  deliveries: [],
  attention: null,
});
const summary = () => ({
  mode: "enabled",
  epoch: 1,
  nextDueAt: null,
  lastDecision: null,
  attentionCode: null,
  remindedHuman: false,
});

const diagnosticCodes = [
  "provider_timeout",
  "provider_unavailable",
  "provider_auth_failed",
  "provider_invalid_response",
  "provider_low_certainty",
  "context_budget_exceeded",
  "context_stale",
  "delivery_unavailable",
  "delivery_unknown",
  "run_repeated_failure",
  "internal_failure",
];
const commandCodes = [
  "unauthorized",
  "not_found",
  "forbidden",
  "conflict",
  "validation_failed",
  "too_many_requests",
  "internal",
  "automation_disabled",
  "wake_provider_unavailable",
  "continuation_delivery_unknown",
];

describe("P6a providers and closed error vocabularies", () => {
  it("selects exactly one supported provider with versioned configuration", () => {
    for (const provider of ["small_brain", "jev"]) {
      expect(wakeProviderSchema.parse(provider)).toBe(provider);
      expect(projectWakePolicySchema.safeParse({ ...policy, provider }).success).toBe(true);
    }
    expect(wakeProviderSchema.safeParse("other").success).toBe(false);
    for (const invalid of [
      { ...policy, provider: "other" },
      { ...policy, provider: ["jev", "small_brain"] },
      { ...policy, fallback: "small_brain" },
      { ...policy, apiKey: "secret" },
      { ...policy, configRevision: 0 },
      { ...policy, model: " " },
    ])
      expect(projectWakePolicySchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps command errors distinct from persisted diagnostics and preserves registered AppErrors", () => {
    expect(wakeEvaluationErrorCodeSchema.options).toEqual(diagnosticCodes);
    expect(chatAutomationErrorCodeSchema.options).toEqual(commandCodes);
    for (const code of diagnosticCodes) {
      expect(wakeEvaluationErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(chatAutomationErrorCodeSchema.safeParse(code).success).toBe(false);
    }
    for (const code of commandCodes) {
      expect(chatAutomationErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(wakeEvaluationErrorCodeSchema.safeParse(code).success).toBe(false);
      expect(APP_ERROR_CODES).toContain(code);
    }
    for (const code of [
      "automation_disabled",
      "wake_provider_unavailable",
      "continuation_delivery_unknown",
    ]) {
      expect(toAppError({ code, message: "安全提示", requestId: "old" }, requestId)).toEqual({
        code,
        message: "安全提示",
        requestId,
      });
    }
    expect(wakeEvaluationErrorCodeSchema.safeParse("new_error").success).toBe(false);
    expect(chatAutomationErrorCodeSchema.safeParse("new_error").success).toBe(false);
    expect(toAppError({ code: "provider_timeout", message: "private" }, requestId)).toEqual({
      code: "internal",
      message: "内部错误",
      requestId,
    });
  });
});

describe("P6a immutable evaluation snapshot", () => {
  it("accepts both sources, preserving the trigger independently of recent history", () => {
    expect(wakeEvaluationInputSchema.safeParse(input()).success).toBe(true);
    const history = [message("历史", 2)];
    const trigger = { ...message("😀".repeat(2000)), truncated: true };
    const parsed = wakeEvaluationInputSchema.parse({
      ...input(history),
      source: "message",
      triggerId: trigger.id,
      triggerMessage: trigger,
      tasks: [],
    });
    expect(parsed.triggerMessage?.body).toBe(trigger.body);
    expect(parsed.triggerMessage?.truncated).toBe(true);
    expect(parsed.recentMessages.map((item) => item.id)).not.toContain(trigger.id);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.candidates)).toBe(true);
    expect(Object.isFrozen(parsed.candidates[0].recipient)).toBe(true);
    expect(Object.isFrozen(parsed.policy)).toBe(true);
  });

  it("requires a real message trigger or assigned Task periodic context", () => {
    for (const source of ["message", "task_periodic"])
      expect(wakeEvaluationSourceSchema.safeParse(source).success).toBe(true);
    expect(wakeEvaluationSourceSchema.safeParse("system").success).toBe(false);
    for (const invalid of [
      { ...input(), source: "message" },
      {
        ...input(),
        source: "message",
        triggerId: "different",
        triggerMessage: message(),
      },
      { ...input(), triggerMessage: message() },
      { ...input(), tasks: [] },
      { ...input(), db: {} },
      { ...input(), now: () => at },
      {
        ...input(),
        tasks: [{ ...task(), chatId: `cnv_00000000-0000-4000-8000-000000000002` }],
      },
      {
        ...input(),
        truncation: { ...input().truncation, tasksComplete: false },
      },
      {
        ...input(),
        truncation: { ...input().truncation, candidatesComplete: false },
      },
    ])
      expect(wakeEvaluationInputSchema.safeParse(invalid).success).toBe(false);
  });

  it("enforces 20 messages, 2000 Unicode characters each, and 12000 recent-body characters", () => {
    expect(WAKE_CONTEXT_LIMITS).toMatchObject({
      recentMessages: 20,
      messageCharacters: 2000,
      recentMessageCharacters: 12000,
      snapshotCharacters: 24000,
    });
    expect(
      wakeEvaluationInputSchema.safeParse(
        input(Array.from({ length: 20 }, (_, index) => message("短", index + 1))),
      ).success,
    ).toBe(true);
    expect(
      wakeEvaluationInputSchema.safeParse(
        input(Array.from({ length: 21 }, (_, index) => message("短", index + 1))),
      ).success,
    ).toBe(false);
    expect(wakeEvaluationInputSchema.safeParse(input([message("😀".repeat(2000))])).success).toBe(
      true,
    );
    expect(wakeEvaluationInputSchema.safeParse(input([message("😀".repeat(2001))])).success).toBe(
      false,
    );
    expect(
      wakeEvaluationInputSchema.safeParse(
        input(Array.from({ length: 6 }, (_, index) => message("字".repeat(2000), index + 1))),
      ).success,
    ).toBe(true);
    expect(
      wakeEvaluationInputSchema.safeParse(
        input(
          Array.from({ length: 7 }, (_, index) =>
            message("字".repeat(index === 6 ? 1 : 2000), index + 1),
          ),
        ),
      ).success,
    ).toBe(false);
    const withTrigger = {
      ...input(Array.from({ length: 6 }, (_, index) => message("字".repeat(2000), index + 2))),
      source: "message",
      triggerId: messageId,
      triggerMessage: { ...message("字".repeat(2000)), truncated: true },
    };
    expect(wakeEvaluationInputSchema.safeParse(withTrigger).success).toBe(true);
  });

  it("validates truncation accounting, order, duplicates, and total snapshot budget", () => {
    const base = input([message()]);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...base,
        truncation: {
          ...base.truncation,
          originalMessageCount: 30,
          droppedMessageIdRange: {
            first: message("", 2).id,
            last: message("", 29).id,
          },
        },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...base, truncation: { ...base.truncation, includedMessageCount: 0 } },
      { ...base, truncation: { ...base.truncation, originalMessageCount: 2 } },
      {
        ...base,
        truncation: { ...base.truncation, recentMessageCharacters: 0 },
      },
      input([message(), message()]),
      input([{ ...message("new", 1), createdAt: "2026-11-01T01:00:00.000Z" }, message("old", 2)]),
      { ...base, candidates: [candidate(), candidate()] },
      { ...base, tasks: [task(), task()] },
      {
        ...base,
        source: "message",
        triggerId: messageId,
        triggerMessage: message(),
        candidates: Array.from({ length: 20 }, (_, index) => ({
          ...candidate(),
          recipient: { ...agent, id: `agent-${index}` },
          personaSummary: "字".repeat(600),
          responsibility: "字".repeat(600),
        })),
      },
    ])
      expect(wakeEvaluationInputSchema.safeParse(invalid).success).toBe(false);
    const parsed = wakeEvaluationInputSchema.parse(base);
    expect(Object.isFrozen(parsed.tasks[0])).toBe(true);
    expect(Object.isFrozen(parsed.recentMessages[0])).toBe(true);
  });

  it("limits candidate/Task text and keeps Human ownership separate from DM Agent responsibility", () => {
    const humanCandidate = {
      ...candidate(),
      recipient: human,
      instanceId: null,
    };
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        chat: { ...input().chat, owner: human },
        candidates: [humanCandidate],
        tasks: [{ ...task(), responsibility: human }],
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        chat: { ...input().chat, kind: "dm", owner: human },
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        candidates: [{ ...candidate(), personaSummary: "字".repeat(601) }],
      }).success,
    ).toBe(false);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        tasks: [
          {
            ...task(),
            lastRecord: {
              id: "record-1",
              seq: 1,
              kind: "progress",
              body: "字".repeat(1000),
              truncated: true,
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        candidates: [{ ...humanCandidate, instanceId }],
      }).success,
    ).toBe(false);
    expect(
      wakeEvaluationInputSchema.safeParse({
        ...input(),
        chat: { ...input().chat, owner: human },
      }).success,
    ).toBe(false);
  });
});

describe("P6a evaluation output", () => {
  it("binds result candidates, snapshot and provider to the supplied input", () => {
    const schema = wakeEvaluationResultForInputSchema(wakeEvaluationInputSchema.parse(input()));
    expect(schema.safeParse(result()).success).toBe(true);
    expect(
      schema.safeParse({
        ...result(),
        decision: "indeterminate",
        recipients: [],
        selectedRecipients: [],
        errorCode: "provider_timeout",
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...result(), snapshotHash: "b".repeat(64) },
      { ...result(), provider: "jev" },
      { ...result(), model: "fallback-model" },
      {
        ...result(),
        decision: "do_not_continue",
        recipients: [],
        selectedRecipients: [],
      },
      {
        ...result(),
        recipients: [{ ...result().recipients[0], recipient: human }],
        selectedRecipients: [human],
      },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
  });

  it("accepts yes/no/unknown, multiple recipients, and partial uncertainty", () => {
    for (const decision of ["yes", "no", "unknown"])
      expect(
        wakeRecipientDecisionSchema.safeParse({
          recipient: agent,
          decision,
          reason: "理由",
          probability: null,
        }).success,
      ).toBe(true);
    for (const invalid of [
      {
        recipient: agent,
        decision: "maybe",
        reason: "理由",
        probability: null,
      },
      { recipient: agent, decision: "yes", reason: " ", probability: null },
      { recipient: agent, decision: "yes", reason: "理由", probability: 1.1 },
    ])
      expect(wakeRecipientDecisionSchema.safeParse(invalid).success).toBe(false);
    expect(wakeEvaluationResultSchema.safeParse(result()).success).toBe(true);
    expect(
      wakeEvaluationResultSchema.safeParse({
        ...result(),
        recipients: [
          ...result().recipients,
          {
            recipient: human,
            decision: "yes",
            reason: "提醒 owner",
            probability: null,
          },
        ],
        selectedRecipients: [agent, human],
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationResultSchema.safeParse({
        ...result(),
        recipients: [
          ...result().recipients,
          {
            recipient: human,
            decision: "unknown",
            reason: "需要核对",
            probability: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationResultSchema.safeParse({
        ...result(),
        decision: "do_not_continue",
        recipients: [],
        selectedRecipients: [],
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationResultSchema.safeParse({
        ...result(),
        decision: "indeterminate",
        recipients: [{ ...result().recipients[0], decision: "unknown" }],
        selectedRecipients: [],
      }).success,
    ).toBe(true);
    expect(
      wakeEvaluationResultSchema.safeParse({
        ...result(),
        decision: "indeterminate",
        recipients: [],
        selectedRecipients: [],
        errorCode: "context_budget_exceeded",
      }).success,
    ).toBe(true);
  });

  it("rejects contradictory decisions, duplicate or unknown recipients, and silent failure as no", () => {
    for (const invalid of [
      { ...result(), decision: "do_not_continue" },
      { ...result(), selectedRecipients: [] },
      { ...result(), selectedRecipients: [human] },
      { ...result(), selectedRecipients: [agent, agent] },
      {
        ...result(),
        recipients: [...result().recipients, ...result().recipients],
      },
      {
        ...result(),
        recipients: [{ ...result().recipients[0], decision: "unknown" }],
      },
      {
        ...result(),
        decision: "do_not_continue",
        recipients: [],
        selectedRecipients: [],
        errorCode: "provider_timeout",
      },
      { ...result(), reason: "" },
      { ...result(), errorCode: "wake_provider_unavailable" },
    ])
      expect(wakeEvaluationResultSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("P6a continuation and Human controls", () => {
  it("freezes modes, timing policy and cancellation reasons separately from failures", () => {
    for (const mode of ["enabled", "off"])
      expect(chatAutomationModeSchema.parse(mode)).toBe(mode);
    for (const mode of ["disabled", "paused", "stopped"])
      expect(chatAutomationModeSchema.safeParse(mode).success).toBe(false);
    expect(CHAT_AUTOMATION_POLICY).toEqual({
      version: 1,
      intervalSeconds: 300,
      retryDelaySeconds: [30, 120],
      maxAttempts: 3,
      repeatedRunFailureLimit: 3,
    });
    expect(continuationCancelReasonSchema.options).toEqual([
      "human_disabled",
      "human_aborted",
      "membership_revoked",
      "task_context_changed",
      "chat_archived",
      "policy_changed",
    ]);
    for (const reason of continuationCancelReasonSchema.options) {
      expect(continuationCancelReasonSchema.parse(reason)).toBe(reason);
      expect(wakeEvaluationErrorCodeSchema.safeParse(reason).success).toBe(false);
    }
    expect(continuationCancelReasonSchema.safeParse("system_stop").success).toBe(false);
    expect(continuationDeliveryStateSchema.safeParse("pending").success).toBe(true);
    expect(continuationDeliveryStateSchema.safeParse("success").success).toBe(false);
  });

  it("accepts unadmitted, admitted, ACKed, canceled and Human reminder facts", () => {
    const pending = delivery();
    for (const valid of [
      pending,
      { ...pending, state: "bound", runId },
      { ...pending, state: "admitted", runId, attempt: 1, admittedAt: at },
      {
        ...pending,
        state: "delivered",
        runId,
        attempt: 1,
        admittedAt: at,
        deliveredAt: at,
      },
      {
        ...pending,
        state: "attention",
        runId,
        attempt: 1,
        admittedAt: at,
        errorCode: "delivery_unknown",
      },
      { ...pending, state: "canceled", cancelReason: "human_disabled" },
      { ...pending, state: "canceled", cancelReason: "human_aborted" },
      {
        ...pending,
        recipient: human,
        instanceId: null,
        state: "presented",
        presentedAt: at,
      },
    ])
      expect(continuationDeliverySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a Human run, missing admission, unknown redelivery and cancellation as failure", () => {
    for (const invalid of [
      {
        ...delivery(),
        recipient: human,
        state: "presented",
        runId,
        presentedAt: at,
      },
      { ...delivery(), state: "bound" },
      { ...delivery(), state: "delivered", runId, deliveredAt: at },
      { ...delivery(), state: "pending", runId, admittedAt: at, attempt: 1 },
      { ...delivery(), state: "attention", errorCode: "delivery_unknown" },
      {
        ...delivery(),
        state: "attention",
        runId,
        admittedAt: at,
        attempt: 1,
        errorCode: "delivery_unknown",
        nextAttemptAt: at,
      },
      { ...delivery(), state: "canceled", errorCode: "human_disabled" },
      { ...delivery(), state: "canceled" },
      { ...delivery(), state: "presented", presentedAt: at },
      { ...delivery(), attempt: 3, nextAttemptAt: at },
    ])
      expect(continuationDeliverySchema.safeParse(invalid).success).toBe(false);
  });

  it("uses a continuation delivery key independently of message input/ACK", () => {
    const parsed = continuationInputEnvelopeSchema.parse(envelope());
    expect(parsed.deliveryId).toBe("delivery-1");
    expect(parsed).not.toHaveProperty("messageId");
    const { deliveryId: omittedDeliveryId, ...withoutDeliveryId } = envelope();
    expect(omittedDeliveryId).toBe("delivery-1");
    for (const invalid of [
      { ...withoutDeliveryId, messageId },
      { ...envelope(), messageId: "delivery-1" },
      { ...envelope(), kind: "message" },
      { ...envelope(), runId: null },
      { ...envelope(), body: "" },
      { ...envelope(), supersedesDeliveryId: "delivery-1" },
    ])
      expect(continuationInputEnvelopeSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires revision/idempotency and explicit confirmation when reissuing unknown input", () => {
    const base = { projectId, chatId, expectedRevision: 1, requestId };
    for (const command of [
      { ...base, action: "disable" },
      { ...base, action: "enable" },
      { ...base, action: "abort" },
      { ...base, action: "abort", runId },
      { ...base, action: "retry", evaluationId: "evaluation-1" },
      {
        ...base,
        action: "reissue",
        deliveryId: "delivery-1",
        confirmedUnknown: true,
      },
    ])
      expect(chatAutomationCommandSchema.safeParse(command).success).toBe(true);
    for (const command of [
      { ...base, action: "disable", expectedRevision: 0 },
      { ...base, action: "pause" },
      { ...base, action: "resume" },
      { ...base, action: "stop", scope: "chat" },
      { ...base, action: "stop_run", runId },
      { ...base, action: "abort", runId: null },
      { ...base, action: "abort", runId: "invalid" },
      { ...base, action: "abort", scope: "chat" },
      { ...base, action: "disable", runId },
      { ...base, action: "enable", runId },
      { ...base, action: "retry", deliveryId: "delivery-1" },
      { ...base, action: "reissue", deliveryId: "delivery-1" },
      {
        ...base,
        action: "reissue",
        deliveryId: "delivery-1",
        confirmedUnknown: false,
      },
      { ...base, action: "enable", actor: { kind: "system" } },
    ])
      expect(chatAutomationCommandSchema.safeParse(command).success).toBe(false);
  });

  it("shows Human owner reminder without fabricated active runs", () => {
    const reminder = {
      ...delivery(),
      recipient: human,
      instanceId: null,
      state: "presented",
      presentedAt: at,
    };
    const humanView = {
      ...view(),
      owner: human,
      remindedHuman: true,
      deliveries: [reminder],
    };
    const parsed = chatAutomationViewSchema.parse(humanView);
    expect(parsed.activeRunIds).toEqual([]);
    expect(parsed.remindedHuman).toBe(true);
    expect(
      chatAutomationViewSchema.safeParse({
        ...humanView,
        activeRunIds: [runId],
      }).success,
    ).toBe(false);
    expect(chatAutomationViewSchema.safeParse({ ...humanView, remindedHuman: false }).success).toBe(
      false,
    );
    // No reminder is invented merely because the owner is Human, before evaluation.
    expect(chatAutomationViewSchema.safeParse({ ...view(), owner: human }).success).toBe(true);
    expect(chatAutomationViewSchema.safeParse({ ...view(), mode: "off" }).success).toBe(false);
    expect(
      chatAutomationViewSchema.safeParse({
        ...view(),
        mode: "off",
        nextDueAt: null,
      }).success,
    ).toBe(true);
    expect(chatAutomationViewSchema.safeParse({ ...view(), epoch: 0 }).success).toBe(false);
    const evaluation = {
      evaluationId: "evaluation-1",
      source: "task_periodic",
      state: "decided",
      round: 1,
      attempt: 1,
      evaluatedAt: at,
      nextAttemptAt: null,
      result: result(),
      errorCode: null,
    };
    expect(chatAutomationEvaluationViewSchema.safeParse(evaluation).success).toBe(true);
    expect(
      chatAutomationEvaluationViewSchema.safeParse({
        ...evaluation,
        state: "succeeded",
      }).success,
    ).toBe(false);
  });

  it("reuses existing access levels and grants Agents reads only", () => {
    const expected = {
      "project.wake_policy.read": { human: "project", agent: "project" },
      "project.wake_policy.update": { human: "human", agent: "never" },
      "chat.automation.read": { human: "member", agent: "member" },
      "chat.automation.disable": { human: "member", agent: "never" },
      "chat.automation.enable": { human: "member", agent: "never" },
      "chat.automation.abort": { human: "member", agent: "never" },
      "chat.automation.retry": { human: "member", agent: "never" },
      "chat.automation.reissue": { human: "member", agent: "never" },
    };
    expect(CHAT_AUTOMATION_CAPABILITIES).toEqual(expected);
    expect(CHAT_AUTOMATION_ACTIONS).toEqual(Object.keys(expected));
  });
});

describe("P6a additive Project, Info Hub and remote boundaries", () => {
  it("exposes provider readiness without accepting credentials", () => {
    const available = {
      provider: "jev",
      configured: true,
      available: true,
      unavailableReason: null,
    };
    expect(wakeProviderAvailabilitySchema.safeParse(available).success).toBe(true);
    expect(
      wakeProviderAvailabilitySchema.safeParse({
        ...available,
        configured: false,
        available: false,
        unavailableReason: "missing_credentials",
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...available, apiKey: "secret" },
      { ...available, configured: false },
      { ...available, available: false },
      { ...available, unavailableReason: "secret text" },
    ])
      expect(wakeProviderAvailabilitySchema.safeParse(invalid).success).toBe(false);
    const update = {
      projectId,
      provider: "jev",
      expectedConfigRevision: 1,
      requestId,
    };
    expect(updateProjectWakePolicyInputSchema.safeParse(update).success).toBe(true);
    expect(
      updateProjectWakePolicyInputSchema.safeParse({
        ...update,
        credentials: "secret",
      }).success,
    ).toBe(false);
    const existing = {
      id: projectId,
      name: "项目",
      createdAt: at,
      updatedAt: at,
    };
    expect(projectSchema.parse(existing)).toEqual(existing);
    expect(
      projectSchema.safeParse({
        ...existing,
        wakePolicy: policy,
        wakeProviderAvailability: [available],
      }).success,
    ).toBe(true);
  });

  it("adds optional minimal automation summaries without making old payloads invalid", () => {
    expect(chatAutomationSummarySchema.safeParse(summary()).success).toBe(true);
    expect(
      chatAutomationSummarySchema.safeParse({
        ...summary(),
        mode: "off",
        nextDueAt: at,
      }).success,
    ).toBe(false);
    const aggregate = {
      taskCounts: { proposed: 0, assigned: 1, finished: 0, canceled: 0 },
      assignedTaskIds: [taskId],
      chatId,
      kind: "group",
      displayTitle: "契约组",
      agentCount: 1,
      statusCounts: [],
      activeRunIds: [],
    };
    expect(chatRunAggregateSchema.safeParse(aggregate).success).toBe(true);
    expect(chatRunAggregateSchema.safeParse({ ...aggregate, automation: summary() }).success).toBe(
      true,
    );
    const info = {
      chatId,
      projectId,
      kind: "group",
      archived: false,
      members: [],
      owner: human,
      instances: [],
      messages: { count: 0 },
      runs: { available: true, hostEnabled: false, active: [], recent: [] },
      tasks: { available: true, items: [] },
    };
    expect(chatInfoViewSchema.safeParse(info).success).toBe(true);
    expect(chatInfoViewSchema.safeParse({ ...info, automation: summary() }).success).toBe(true);
  });

  it("adds only read automation tool/call shapes, bound to the active run Chat", () => {
    expect(remoteToolInputSchemas.sprout_chat_automation_get.parse({})).toEqual({});
    expect(
      remoteToolInputSchemas.sprout_chat_automation_get.safeParse({
        action: "disable",
      }).success,
    ).toBe(false);
    const call = { type: "chat_automation_get", input: { projectId } };
    expect(chatAutomationGetInputSchema.parse({ projectId })).toEqual({
      projectId,
    });
    expect(chatAutomationGetInputSchema.safeParse({ projectId, chatId }).success).toBe(false);
    expect(chatAutomationGetCall.parse(call)).toEqual(call);
    expect(
      chatAutomationGetCall.safeParse({
        ...call,
        type: "chat_automation_disable",
      }).success,
    ).toBe(false);
    expect(remoteAgentRequestSchema.safeParse({ version: 2, call }).success).toBe(true);
    expect(
      remoteAgentRequestSchema.safeParse({
        version: 2,
        call: { type: "chat_automation_disable", input: { projectId } },
      }).success,
    ).toBe(false);
    expect(chatAutomationGetResponseSchema.parse(view())).toEqual(view());
  });
});
