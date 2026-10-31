import { z } from "zod";
import { runIdSchema } from "./agent-run";
import { chatOwnerSchema } from "./chat";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { taskIdSchema, taskRecordRefSchema } from "./task";
import {
  wakeEvaluationErrorCodeSchema,
  wakeEvaluationResultSchema,
  wakeEvaluationSourceSchema,
} from "./wake-evaluation";

const identifier = z.string().trim().min(1).max(200);
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const instanceId = z.string().regex(appIdPattern(ID_PREFIXES.instance));
const requestId = z.string().regex(appIdPattern(ID_PREFIXES.request));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const reason = z.string().trim().min(1).max(2000);

export const chatAutomationModeSchema = z.enum(["enabled", "paused", "stopped"]);
export type ChatAutomationMode = z.infer<typeof chatAutomationModeSchema>;
export const chatAutomationErrorCodeSchema = z.enum([
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
]);
export type ChatAutomationErrorCode = z.infer<typeof chatAutomationErrorCodeSchema>;

export const CHAT_AUTOMATION_POLICY = {
  version: 1,
  intervalSeconds: 300,
  retryDelaySeconds: [30, 120],
  maxAttempts: 3,
  repeatedRunFailureLimit: 3,
} as const;

export const continuationCancelReasonSchema = z.enum([
  "human_paused",
  "human_stopped",
  "membership_revoked",
  "task_context_changed",
  "chat_archived",
  "policy_changed",
]);
export type ContinuationCancelReason = z.infer<typeof continuationCancelReasonSchema>;

export const continuationDeliveryStateSchema = z.enum([
  "pending",
  "bound",
  "admitted",
  "delivered",
  "attention",
  "canceled",
  "presented",
  "stale",
]);
export type ContinuationDeliveryState = z.infer<typeof continuationDeliveryStateSchema>;

/** Human reminders have no host admission or run. Unknown delivery keeps its original run. */
export const continuationDeliverySchema = z
  .strictObject({
    deliveryId: identifier,
    evaluationId: identifier,
    projectId,
    chatId,
    recipient: z.strictObject({
      kind: z.enum(["agent", "human"]),
      id: identifier,
    }),
    instanceId: instanceId.nullable(),
    runId: runIdSchema.nullable(),
    controlEpoch: revision,
    snapshotHash: hash,
    state: continuationDeliveryStateSchema,
    attempt: count.max(CHAT_AUTOMATION_POLICY.maxAttempts),
    taskIds: z.array(taskIdSchema),
    createdAt: z.iso.datetime(),
    admittedAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    presentedAt: z.iso.datetime().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
    cancelReason: continuationCancelReasonSchema.nullable(),
    errorCode: wakeEvaluationErrorCodeSchema.nullable(),
    supersedesDeliveryId: identifier.nullable(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.recipient.kind === "human") {
      if (
        value.instanceId !== null ||
        value.runId !== null ||
        value.admittedAt !== null ||
        value.deliveredAt !== null ||
        !["presented", "stale", "canceled"].includes(value.state)
      )
        reject("Human delivery is only a reminder, without a run or admission");
      if (value.state === "presented" && value.presentedAt === null)
        reject("Presented reminder requires presentedAt");
    } else {
      if (value.instanceId === null || value.presentedAt !== null || value.state === "presented")
        reject("Agent delivery requires an instance, never a Human reminder");
      if (["bound", "admitted", "delivered"].includes(value.state) && value.runId === null)
        reject("Bound/admitted/delivered Agent input requires a run");
    }
    if (["admitted", "delivered"].includes(value.state) && value.admittedAt === null)
      reject("Admission timestamp required");
    if (value.state === "delivered" && value.deliveredAt === null)
      reject("Delivered input requires ACK timestamp");
    if (value.deliveredAt !== null && (value.admittedAt === null || value.state !== "delivered"))
      reject("ACK requires admitted delivery");
    if (
      value.admittedAt !== null &&
      (value.runId === null ||
        !["admitted", "delivered", "attention"].includes(value.state) ||
        value.attempt === 0)
    )
      reject("Admitted input cannot return to pending, canceled or unattempted");
    if (
      value.errorCode === "delivery_unknown" &&
      (value.state !== "attention" ||
        value.admittedAt === null ||
        value.runId === null ||
        value.deliveredAt !== null ||
        value.nextAttemptAt !== null)
    )
      reject("Unknown delivery must preserve admission and cannot automatically retry");
    if (value.state === "attention" && value.errorCode === null)
      reject("Attention requires an error code");
    if ((value.state === "canceled") !== (value.cancelReason !== null))
      reject("Canceled delivery requires its separate cancellation reason");
    if (
      value.nextAttemptAt !== null &&
      (value.state !== "pending" ||
        value.admittedAt !== null ||
        value.attempt >= CHAT_AUTOMATION_POLICY.maxAttempts)
    )
      reject("Only unadmitted pending input may retry within budget");
    if (new Set(value.taskIds).size !== value.taskIds.length) reject("Duplicate Task association");
    if (value.supersedesDeliveryId === value.deliveryId)
      reject("A reissued input must have a new delivery id");
    if (
      value.deliveredAt !== null &&
      value.admittedAt !== null &&
      Date.parse(value.deliveredAt) < Date.parse(value.admittedAt)
    )
      reject("ACK cannot precede admission");
  });
export type ContinuationDelivery = z.infer<typeof continuationDeliverySchema>;

/** Stable delivery key is independent of message input/ACK. No messageId field is accepted. */
export const continuationInputEnvelopeSchema = z
  .strictObject({
    kind: z.literal("continuation"),
    deliveryId: identifier,
    evaluationId: identifier,
    projectId,
    chatId,
    runId: runIdSchema,
    instanceId,
    controlEpoch: revision,
    snapshotHash: hash,
    source: wakeEvaluationSourceSchema,
    taskIds: z.array(taskIdSchema),
    recordRefs: z.array(taskRecordRefSchema),
    body: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 12000),
    supersedesDeliveryId: identifier.nullable(),
  })
  .refine(
    (value) => value.deliveryId !== value.supersedesDeliveryId,
    "Reissue must use a new delivery key",
  );
export type ContinuationInputEnvelope = z.infer<typeof continuationInputEnvelopeSchema>;

const commandBase = {
  projectId,
  chatId,
  expectedRevision: revision,
  requestId,
};
export const chatAutomationCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...commandBase,
    action: z.literal("pause"),
    reason: reason.optional(),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("resume"),
    reason: reason.optional(),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("stop"),
    scope: z.literal("chat"),
    reason: reason.optional(),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("stop_run"),
    runId: runIdSchema,
    reason: reason.optional(),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("retry"),
    evaluationId: identifier,
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("reissue"),
    deliveryId: identifier,
    confirmedUnknown: z.literal(true),
  }),
]);
export type ChatAutomationCommand = z.infer<typeof chatAutomationCommandSchema>;

export const chatAutomationEvaluationViewSchema = z.strictObject({
  evaluationId: identifier,
  source: wakeEvaluationSourceSchema,
  state: z.enum(["pending", "claimed", "retry_wait", "decided", "attention", "stale", "canceled"]),
  round: revision,
  attempt: count.max(CHAT_AUTOMATION_POLICY.maxAttempts),
  evaluatedAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  result: wakeEvaluationResultSchema.nullable(),
  errorCode: wakeEvaluationErrorCodeSchema.nullable(),
});
export type ChatAutomationEvaluationView = z.infer<typeof chatAutomationEvaluationViewSchema>;

export const chatAutomationViewSchema = z
  .strictObject({
    projectId,
    chatId,
    mode: chatAutomationModeSchema,
    epoch: revision,
    revision,
    owner: chatOwnerSchema,
    changedBy: identifier.nullable(),
    changedAt: z.iso.datetime().nullable(),
    reason: reason.nullable(),
    assignedTaskIds: z.array(taskIdSchema),
    nextDueAt: z.iso.datetime().nullable(),
    activeRunIds: z.array(runIdSchema),
    remindedHuman: z.boolean(),
    latestEvaluation: chatAutomationEvaluationViewSchema.nullable(),
    deliveries: z.array(continuationDeliverySchema),
    attention: z
      .strictObject({
        errorCode: wakeEvaluationErrorCodeSchema,
        reason,
        requestId,
        evaluationId: identifier.nullable(),
        deliveryId: identifier.nullable(),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      (value.mode !== "enabled" || value.assignedTaskIds.length === 0) &&
      value.nextDueAt !== null
    )
      reject("Disabled automation or no assigned Tasks has no executable schedule");
    if (value.remindedHuman && (value.owner.kind !== "human" || value.activeRunIds.length !== 0))
      reject("Human reminder must not claim active Agent runs");
    if (
      value.deliveries.some(
        (item) => item.projectId !== value.projectId || item.chatId !== value.chatId,
      )
    )
      reject("Deliveries must belong to this Project/Chat");
    if (
      value.deliveries.some(
        (item) =>
          item.recipient.kind === "human" &&
          item.recipient.id === value.owner.id &&
          item.state === "presented",
      ) &&
      !value.remindedHuman
    )
      reject("Presented owner reminder must be visible");
    if ((value.changedBy === null) !== (value.changedAt === null))
      reject("Control audit identity and timestamp must appear together");
  });
export type ChatAutomationView = z.infer<typeof chatAutomationViewSchema>;
