import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";

export const delegationIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.delegation));
export const delegationChatIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.chat));
export const delegationStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "canceling",
  "canceled",
]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const delegationEventKindSchema = z.enum([
  "dispatched",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);
export type DelegationEventKind = z.infer<typeof delegationEventKindSchema>;

export const delegationDeliveryStateSchema = z.enum([
  "pending",
  "bound",
  "injected",
  "acknowledged",
  "stale",
  "attention",
]);
export type DelegationDeliveryState = z.infer<typeof delegationDeliveryStateSchema>;

const nonEmptySummary = z.string().trim().min(1).max(8000);
const clientRequestId = z.string().trim().min(8).max(128);

const terminalReasonSchema = z.enum([
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "crew_stopped",
  "resource_unavailable",
]);

export const dispatchDelegationInput = z.strictObject({
  chatId: delegationChatIdSchema,
  workerProfileId: agentProfileIdSchema,
  request: nonEmptySummary,
  clientRequestId,
});
export type DispatchDelegationInput = z.infer<typeof dispatchDelegationInput>;

export const dispatchDelegationResultSchema = z.strictObject({
  delegationId: delegationIdSchema,
  childChatId: delegationChatIdSchema,
  status: delegationStatusSchema,
  /** 只有真正生成了 worker run 才是 true；重放同 clientRequestId 不会重复派发。 */
  created: z.boolean(),
});
export type DispatchDelegationResult = z.infer<typeof dispatchDelegationResultSchema>;

export const cancelDelegationInput = z.strictObject({
  delegationId: delegationIdSchema,
  reason: z.string().trim().min(1).max(1000),
});
export type CancelDelegationInput = z.infer<typeof cancelDelegationInput>;

export const retryDelegationInput = z.strictObject({
  delegationId: delegationIdSchema,
  clientRequestId,
});
export type RetryDelegationInput = z.infer<typeof retryDelegationInput>;

export const delegationResultArtifactSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  html: z.string().min(1).max(262_144),
});
export type DelegationResultArtifact = z.infer<typeof delegationResultArtifactSchema>;

/** Worker 只能提交结果摘要与可选 HTML artifact；状态迁移由领域层决定。 */
export const workerDelegationResultInput = z.strictObject({
  summary: nonEmptySummary.max(8192),
  artifact: delegationResultArtifactSchema.optional(),
});
export type WorkerDelegationResultInput = z.infer<typeof workerDelegationResultInput>;

export const workerDelegationBlockInput = z.strictObject({
  summary: nonEmptySummary,
  reason: z.enum(["needs_input", "resource_unavailable", "out_of_scope", "failed"]),
});
export type WorkerDelegationBlockInput = z.infer<typeof workerDelegationBlockInput>;

export const delegationViewSchema = z.strictObject({
  id: delegationIdSchema,
  parentCrewChatId: delegationChatIdSchema,
  childChatId: delegationChatIdSchema,
  workerProfileId: agentProfileIdSchema,
  workerName: z.string(),
  dispatchLeadProfileId: agentProfileIdSchema,
  crewEpoch: z.number().int().nonnegative(),
  requestSummary: z.string(),
  status: delegationStatusSchema,
  attempt: z.number().int().positive(),
  resultRevision: z.number().int().nonnegative(),
  terminalSummary: z.string().nullable(),
  terminalReason: terminalReasonSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  settledAt: z.number().int().nonnegative().nullable(),
});
export type DelegationView = z.infer<typeof delegationViewSchema>;

export const delegationEventViewSchema = z.strictObject({
  id: z.string(),
  delegationId: delegationIdSchema,
  kind: delegationEventKindSchema,
  revision: z.number().int().nonnegative(),
  summary: z.string(),
  resultArtifactId: z.string().nullable(),
  progressCount: z.number().int().nonnegative(),
  deliveryState: delegationDeliveryStateSchema,
  createdAt: z.number().int().nonnegative(),
});
export type DelegationEventView = z.infer<typeof delegationEventViewSchema>;

export const crewDelegationViewSchema = z.strictObject({
  delegations: z.array(delegationViewSchema),
  events: z.array(delegationEventViewSchema),
});
export type CrewDelegationView = z.infer<typeof crewDelegationViewSchema>;

/** Worker-facing tool inputs; Project comes from the run grant, never from parameters. */
export const delegationToolInputSchemas = {
  sprout_delegation_complete: z.strictObject({
    delegationId: delegationIdSchema,
    summary: nonEmptySummary.max(8192),
    artifact: delegationResultArtifactSchema.optional(),
  }),
  sprout_delegation_block: z.strictObject({
    delegationId: delegationIdSchema,
    summary: nonEmptySummary,
    reason: z.enum(["needs_input", "resource_unavailable", "out_of_scope", "failed"]),
  }),
};
export type DelegationToolName = keyof typeof delegationToolInputSchemas;

export const delegationMutateInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    projectId: z.string(),
    action: z.literal("complete"),
    delegationId: delegationIdSchema,
    summary: nonEmptySummary.max(8192),
    artifact: delegationResultArtifactSchema.optional(),
  }),
  z.strictObject({
    projectId: z.string(),
    action: z.literal("block"),
    delegationId: delegationIdSchema,
    summary: nonEmptySummary,
    reason: z.enum(["needs_input", "resource_unavailable", "out_of_scope", "failed"]),
  }),
]);
export type DelegationMutateInput = z.infer<typeof delegationMutateInputSchema>;

export const crewDelegationToolInputSchemas = {
  sprout_delegation_start: z.strictObject({
    workerProfileId: z.string().min(1),
    request: z.string().min(1).max(8000),
    clientRequestId: z.string().min(8).max(128).optional(),
  }),
  sprout_delegation_input: z.strictObject({
    delegationId: delegationIdSchema,
    text: z.string().min(1).max(8000),
  }),
  sprout_delegation_cancel: z.strictObject({
    delegationId: delegationIdSchema,
    reason: z.string().min(1).max(500),
  }),
  sprout_delegation_list: z.strictObject({}),
};
export type CrewDelegationToolName = keyof typeof crewDelegationToolInputSchemas;

export const crewMutateInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    projectId: z.string(),
    action: z.literal("dispatch"),
    workerProfileId: z.string().min(1),
    request: z.string().min(1).max(8000),
    clientRequestId: z.string().min(8).max(128).optional(),
  }),
  z.strictObject({
    projectId: z.string(),
    action: z.literal("input"),
    delegationId: delegationIdSchema,
    text: z.string().min(1).max(8000),
  }),
  z.strictObject({
    projectId: z.string(),
    action: z.literal("cancel"),
    delegationId: delegationIdSchema,
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    projectId: z.string(),
    action: z.literal("list"),
  }),
]);
export type CrewMutateInput = z.infer<typeof crewMutateInputSchema>;

export const crewMutateResponseSchema = z.looseObject({
  projectId: z.string(),
  chatId: z.string(),
});

export const delegationMutateResponseSchema = z.strictObject({
  projectId: z.string(),
  chatId: delegationChatIdSchema,
  delegationId: delegationIdSchema,
  status: delegationStatusSchema,
});
