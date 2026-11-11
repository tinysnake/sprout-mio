import { z } from "zod";

export const RUN_ATTENTION_DEFAULT_MS = 1_800_000;
const duration = z.number().int().min(1_000).max(Number.MAX_SAFE_INTEGER);

export const runAttentionPolicySchema = z
  .strictObject({
    timeoutMs: duration,
    escalationMs: duration,
  })
  .refine((policy) => {
    const total = policy.timeoutMs + policy.escalationMs;
    return Number.isSafeInteger(total) && Number.isFinite(new Date(Date.now() + total).getTime());
  }, "注意力时长总和必须在安全整数与 Date 有效范围内");
export type RunAttentionPolicy = z.infer<typeof runAttentionPolicySchema>;
export const DEFAULT_RUN_ATTENTION_POLICY = Object.freeze({
  timeoutMs: RUN_ATTENTION_DEFAULT_MS,
  escalationMs: RUN_ATTENTION_DEFAULT_MS,
} satisfies RunAttentionPolicy);

export function resolveRunAttentionPolicy(value: unknown): RunAttentionPolicy {
  const parsed = runAttentionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RUN_ATTENTION_POLICY;
}

export type RunAttentionSnapshot = RunAttentionPolicy & {
  target?: { kind: "agent" | "human"; id: string };
  humanRecipientIds?: string[];
};

export const runAttentionFactsSchema = z.strictObject({
  deadlineAt: z.iso.datetime(),
  humanReminderAt: z.iso.datetime(),
  attentionAt: z.iso.datetime().nullable(),
  humanRequiredAt: z.iso.datetime().nullable(),
  humanNotifiedAt: z.iso.datetime().nullable(),
  awaitingHandling: z.boolean(),
  ownerAutoAttemptsPaused: z.boolean(),
});
export type RunAttentionFacts = z.infer<typeof runAttentionFactsSchema>;

export const RUN_ATTENTION_SENDER_ID = "sprout.run-attention";
export function isRunAttentionSender(senderId: string): boolean {
  return senderId === RUN_ATTENTION_SENDER_ID;
}
export function runAttentionSenderLabel(senderId: string): string | null {
  return isRunAttentionSender(senderId) ? "运行注意力提醒" : null;
}
