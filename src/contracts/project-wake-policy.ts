import { z } from "zod";

export const wakeProviderSchema = z.enum(["small_brain", "jev"]);
export type WakeProvider = z.infer<typeof wakeProviderSchema>;

/** Independent Project configuration: no Chat, Task or run schema dependencies. */
export const projectWakePolicySchema = z.strictObject({
  provider: wakeProviderSchema,
  configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // Omitted model uses the host default model.
  model: z.string().trim().min(1).max(200).optional(),
  thresholdVersion: z.string().trim().min(1).max(80),
});
export type ProjectWakePolicy = z.infer<typeof projectWakePolicySchema>;

/** Read-time policy for Projects that have never been configured by a human. */
export const DEFAULT_PROJECT_WAKE_POLICY = Object.freeze({
  provider: "small_brain",
  configRevision: 1,
  thresholdVersion: "p6a-design-default-v1",
} satisfies ProjectWakePolicy);
