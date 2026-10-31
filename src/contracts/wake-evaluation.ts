import { z } from "zod";
import { chatKindSchema, chatWakePolicySchema } from "./chat";
import { runIdSchema } from "./agent-run";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { taskIdSchema, taskRecordKindSchema, taskRecordRefSchema } from "./task";

export const wakeProviderSchema = z.enum(["small_brain", "jev"]);
export type WakeProvider = z.infer<typeof wakeProviderSchema>;

/** One selected provider per Project; configuration contains no credentials or fallback. */
export const projectWakePolicySchema = z.strictObject({
  provider: wakeProviderSchema,
  configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  model: z.string().trim().min(1).max(200),
  thresholdVersion: z.string().trim().min(1).max(80),
});
export type ProjectWakePolicy = z.infer<typeof projectWakePolicySchema>;

export const wakeEvaluationSourceSchema = z.enum(["message", "task_periodic"]);
export type WakeEvaluationSource = z.infer<typeof wakeEvaluationSourceSchema>;
export const wakeEvaluationErrorCodeSchema = z.enum([
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
]);
export type WakeEvaluationErrorCode = z.infer<typeof wakeEvaluationErrorCodeSchema>;

export const WAKE_CONTEXT_LIMITS = {
  recentMessages: 20,
  messageCharacters: 2000,
  recentMessageCharacters: 12000,
  personaCharacters: 600,
  taskCharacters: 1000,
  snapshotCharacters: 24000,
} as const;

const identifier = z.string().trim().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const instanceId = z.string().regex(appIdPattern(ID_PREFIXES.instance));
const messageId = z.string().regex(appIdPattern(ID_PREFIXES.message));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const characters = (value: string) => Array.from(value).length;
const text = (max: number) => z.string().refine((value) => characters(value) <= max);
const reason = z.string().trim().min(1).max(2000);
const recipient = z.strictObject({
  kind: z.enum(["agent", "human"]),
  id: identifier,
});

export const wakeRecipientDecisionSchema = z.strictObject({
  recipient,
  decision: z.enum(["yes", "no", "unknown"]),
  reason,
  probability: z.number().min(0).max(1).nullable(),
});
export type WakeRecipientDecision = z.infer<typeof wakeRecipientDecisionSchema>;

/** All nested objects/arrays in an evaluation input are readonly snapshots. */
const snapshotRecipient = recipient.readonly();
const message = z
  .strictObject({
    id: messageId,
    kind: z.enum(["human", "agent"]),
    sender: snapshotRecipient,
    body: text(WAKE_CONTEXT_LIMITS.messageCharacters),
    createdAt: z.iso.datetime(),
    truncated: z.boolean(),
  })
  .refine((value) => value.kind === value.sender.kind, "Message kind must match sender")
  .readonly();
const run = z
  .strictObject({
    id: runIdSchema,
    status: z.enum(["queued", "running", "completed", "failed", "aborted"]),
    updatedAt: z.iso.datetime(),
    pendingInputs: count,
    attemptedInputs: count,
  })
  .readonly();
const candidate = z
  .strictObject({
    recipient: snapshotRecipient,
    instanceId: instanceId.nullable(),
    personaSummary: text(WAKE_CONTEXT_LIMITS.personaCharacters),
    responsibility: text(600),
    activeRun: run.nullable(),
    latestRun: run.nullable(),
    externalWork: z
      .array(
        z
          .strictObject({
            kind: z.enum(["lease", "execution"]),
            id: identifier,
            projectId,
            state: z.enum([
              "active",
              "queued",
              "running",
              "draining",
              "succeeded",
              "failed",
              "rejected",
              "timed_out",
              "released",
              "expired",
              "unknown",
            ]),
            summary: text(600),
          })
          .readonly(),
      )
      .readonly(),
  })
  .superRefine((value, ctx) => {
    if (
      value.recipient.kind === "human" &&
      (value.instanceId !== null || value.activeRun !== null || value.latestRun !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Human recipients have no instance or run",
      });
    }
    if (value.recipient.kind === "agent" && value.instanceId === null) {
      ctx.addIssue({
        code: "custom",
        message: "Agent recipients require an instance",
      });
    }
    if (value.activeRun && !["queued", "running"].includes(value.activeRun.status)) {
      ctx.addIssue({
        code: "custom",
        message: "Active run must be queued or running",
      });
    }
    if (value.latestRun && !["completed", "failed", "aborted"].includes(value.latestRun.status)) {
      ctx.addIssue({ code: "custom", message: "Latest run must be terminal" });
    }
  })
  .readonly();
const task = z
  .strictObject({
    id: taskIdSchema,
    title: text(120),
    status: z.literal("assigned"),
    revision,
    assignmentRevision: revision,
    chatId,
    responsibility: snapshotRecipient,
    checklistTotal: count,
    checklistChecked: count,
    recordCount: count,
    lastRecord: z
      .strictObject({
        id: identifier,
        seq: revision,
        kind: taskRecordKindSchema,
        body: text(WAKE_CONTEXT_LIMITS.taskCharacters),
        truncated: z.boolean(),
      })
      .readonly()
      .nullable(),
    previousCompletionRef: taskRecordRefSchema.readonly().nullable(),
  })
  .refine((value) => value.checklistChecked <= value.checklistTotal, "Invalid checklist counts")
  .refine(
    (value) =>
      characters(value.title) + characters(value.lastRecord?.body ?? "") <=
      WAKE_CONTEXT_LIMITS.taskCharacters,
    "Task text exceeds character budget",
  )
  .readonly();

export const wakeEvaluationInputSchema = z
  .strictObject({
    source: wakeEvaluationSourceSchema,
    projectId,
    chatId,
    triggerId: identifier,
    round: revision,
    controlEpoch: revision,
    policy: projectWakePolicySchema.readonly(),
    evaluatedAt: z.iso.datetime(),
    triggerMessage: message.nullable(),
    latestReadableMessageId: messageId.nullable(),
    recentMessages: z.array(message).max(WAKE_CONTEXT_LIMITS.recentMessages).readonly(),
    chat: z
      .strictObject({
        kind: chatKindSchema,
        goal: text(1000),
        collaboration: text(1000),
        owner: snapshotRecipient,
        wakePolicy: chatWakePolicySchema,
        governanceRevision: revision,
      })
      .readonly(),
    candidates: z.array(candidate).readonly(),
    tasks: z.array(task).readonly(),
    truncation: z
      .strictObject({
        originalMessageCount: count,
        includedMessageCount: count,
        droppedMessageIdRange: z
          .strictObject({ first: messageId, last: messageId })
          .readonly()
          .nullable(),
        tasksComplete: z.literal(true),
        candidatesComplete: z.literal(true),
        recentMessageCharacters: count.max(WAKE_CONTEXT_LIMITS.recentMessageCharacters),
        characterBudget: z.literal(WAKE_CONTEXT_LIMITS.snapshotCharacters),
      })
      .readonly(),
    snapshotHash: hash,
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      value.source === "message" &&
      (!value.triggerMessage || value.triggerId !== value.triggerMessage.id)
    )
      reject("Message source requires its independent trigger message");
    if (
      value.source === "task_periodic" &&
      (value.triggerMessage !== null || value.tasks.length === 0)
    )
      reject("Periodic source requires assigned Tasks and no trigger message");
    const ids = value.recentMessages.map((item) => item.id);
    if (new Set(ids).size !== ids.length) reject("Duplicate recent message");
    if (
      value.recentMessages.some(
        (item, index, items) =>
          index > 0 && Date.parse(item.createdAt) < Date.parse(items[index - 1].createdAt),
      )
    )
      reject("Recent messages must be chronological");
    const total = value.recentMessages.reduce((sum, item) => sum + characters(item.body), 0);
    if (
      total > WAKE_CONTEXT_LIMITS.recentMessageCharacters ||
      total !== value.truncation.recentMessageCharacters
    )
      reject("Recent message character budget mismatch");
    if (
      value.truncation.includedMessageCount !== ids.length ||
      value.truncation.originalMessageCount < ids.length
    )
      reject("Message counts do not match snapshot");
    if (
      value.truncation.originalMessageCount > ids.length !==
      (value.truncation.droppedMessageIdRange !== null)
    )
      reject("Dropped message range must reflect omitted messages");
    const keys = value.candidates.map((item) => `${item.recipient.kind}:${item.recipient.id}`);
    if (new Set(keys).size !== keys.length) reject("Duplicate candidate");
    if (new Set(value.tasks.map((item) => item.id)).size !== value.tasks.length)
      reject("Duplicate Task");
    if (value.tasks.some((item) => item.chatId !== value.chatId))
      reject("Tasks must belong to this Chat");
    if (
      value.candidates.some((item) =>
        item.externalWork.some((work) => work.projectId !== value.projectId),
      )
    )
      reject("External work must belong to this Project");
    if (
      value.source === "task_periodic" &&
      value.chat.kind !== "dm" &&
      (value.candidates.length !== 1 ||
        value.candidates.some(
          (item) =>
            item.recipient.kind !== value.chat.owner.kind ||
            item.recipient.id !== value.chat.owner.id,
        ))
    )
      reject("Periodic Group/Channel candidate must be the current owner");
    if (
      value.source === "task_periodic" &&
      value.chat.kind === "dm" &&
      (value.candidates.length !== 1 || value.candidates[0].recipient.kind !== "agent")
    )
      reject("Periodic DM candidate must be its unique Agent instance");
    if (characters(JSON.stringify(value)) > WAKE_CONTEXT_LIMITS.snapshotCharacters)
      reject("Snapshot exceeds total character budget");
  })
  .readonly();
export type WakeEvaluationInput = z.infer<typeof wakeEvaluationInputSchema>;

/** Selected recipients are exactly the explicit yes decisions; unknown never wakes. */
export const wakeEvaluationResultSchema = z
  .strictObject({
    decision: z.enum(["continue", "do_not_continue", "indeterminate"]),
    reason,
    reasonCode: identifier,
    recipients: z.array(wakeRecipientDecisionSchema),
    selectedRecipients: z.array(recipient),
    probability: z.number().min(0).max(1).nullable(),
    provider: wakeProviderSchema,
    model: identifier,
    version: identifier,
    snapshotHash: hash,
    errorCode: wakeEvaluationErrorCodeSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const key = (item: z.infer<typeof recipient>) => `${item.kind}:${item.id}`;
    const decisions = new Map(value.recipients.map((item) => [key(item.recipient), item.decision]));
    const selected = new Set(value.selectedRecipients.map(key));
    if (
      decisions.size !== value.recipients.length ||
      selected.size !== value.selectedRecipients.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate recipient" });
    if (
      value.selectedRecipients.some((item) => decisions.get(key(item)) !== "yes") ||
      value.recipients.some((item) => item.decision === "yes" && !selected.has(key(item.recipient)))
    )
      ctx.addIssue({
        code: "custom",
        message: "Select exactly the yes recipients",
      });
    const expected =
      selected.size > 0
        ? "continue"
        : value.recipients.some((item) => item.decision === "unknown") || value.errorCode !== null
          ? "indeterminate"
          : "do_not_continue";
    if (value.decision !== expected)
      ctx.addIssue({
        code: "custom",
        message: "Decision contradicts recipients or error",
      });
  });
export type WakeEvaluationResult = z.infer<typeof wakeEvaluationResultSchema>;

/** Bind response validation to its immutable input without copying the snapshot into the response. */
export function wakeEvaluationResultForInputSchema(input: WakeEvaluationInput) {
  const candidates = new Set(
    input.candidates.map((item) => `${item.recipient.kind}:${item.recipient.id}`),
  );
  return wakeEvaluationResultSchema.superRefine((value, ctx) => {
    if (
      value.snapshotHash !== input.snapshotHash ||
      value.provider !== input.policy.provider ||
      value.model !== input.policy.model
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Result must match snapshot and selected provider/model",
      });
    }
    if (
      value.recipients.some(
        (item) => !candidates.has(`${item.recipient.kind}:${item.recipient.id}`),
      ) ||
      (value.errorCode === null && value.recipients.length !== candidates.size)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Result must cover exactly the input candidates unless evaluation failed",
      });
    }
  });
}
