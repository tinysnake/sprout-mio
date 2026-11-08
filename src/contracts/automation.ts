import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";

const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const ruleId = z.string().regex(appIdPattern(ID_PREFIXES.webhookRule));
const triggerId = z.string().regex(appIdPattern(ID_PREFIXES.webhookTrigger));

export const automationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("dm_agent"),
    chatId: chatId.optional(),
    agentProfileId: agentProfileIdSchema,
  }),
  z.strictObject({ kind: z.literal("group_agent"), chatId, agentProfileId: agentProfileIdSchema }),
  z.strictObject({ kind: z.literal("group_owner"), chatId }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

export const webhookRuleDraftSchema = z.strictObject({
  projectId,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  instruction: z.string().trim().min(1).max(8000),
  action: automationActionSchema,
});
export type WebhookRuleDraft = z.infer<typeof webhookRuleDraftSchema>;

export const webhookRuleSchema = webhookRuleDraftSchema.extend({
  id: ruleId,
  revision: z.number().int().nonnegative(),
  endpoint: z.string().url(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WebhookRule = z.infer<typeof webhookRuleSchema>;

const webhookTriggerBase = z.strictObject({
  id: triggerId,
  ruleId,
  mode: z.enum(["live", "trial"]),
  eventId: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
});
export const webhookTriggerSchema = z.discriminatedUnion("decision", [
  webhookTriggerBase.extend({
    decision: z.literal("accepted"),
    messageId: z.string().regex(appIdPattern(ID_PREFIXES.message)),
  }),
  webhookTriggerBase.extend({ decision: z.literal("skipped"), reason: z.string().min(1) }),
]);
export type WebhookTrigger = z.infer<typeof webhookTriggerSchema>;

export const webhookEventSchema = z.record(z.string(), z.unknown());
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const automationRuleIdInput = z.object({ ruleId });
export const webhookUpdateInput = webhookRuleDraftSchema.extend({
  ruleId,
  expectedRevision: z.number().int().nonnegative(),
});
export const webhookTrialInput = z.strictObject({
  ruleId,
  eventId: z.string().trim().min(1).max(200),
  payload: webhookEventSchema,
});

export const cronRuleDraftSchema = webhookRuleDraftSchema.extend({
  expression: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
});
export type CronRuleDraft = z.infer<typeof cronRuleDraftSchema>;
export const cronRuleSchema = cronRuleDraftSchema.extend({
  id: ruleId,
  revision: z.number().int().nonnegative(),
  nextAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CronRule = z.infer<typeof cronRuleSchema>;
export const cronUpdateInput = cronRuleDraftSchema.extend({
  ruleId,
  expectedRevision: z.number().int().nonnegative(),
});
export const cronTrialInput = z.strictObject({
  ruleId,
  eventId: z.string().trim().min(1).max(200),
});
export type CronTrigger = WebhookTrigger & {
  source: "cron";
  expression: string;
  timezone: string;
  scheduledAt: string | null;
};
export const automationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project_webhook"), triggerId }),
  z.strictObject({
    kind: z.literal("project_cron"),
    triggerId,
    expression: z.string(),
    timezone: z.string(),
    instruction: z.string(),
    scheduledAt: z.iso.datetime().nullable(),
    mode: z.enum(["live", "trial"]),
  }),
]);
export type AutomationSource = z.infer<typeof automationSourceSchema>;
export type AutomationHistory<T = WebhookTrigger> = T & {
  source: "webhook" | "cron";
  chatId: string | null;
  runId: string | null;
  runStatus: string | null;
  inputDisposition: string | null;
  cancelReason: string | null;
};
