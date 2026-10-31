import { z } from "zod";

export const wakeProviderSchema = z.enum(["small_brain", "jev"]);
export type WakeProvider = z.infer<typeof wakeProviderSchema>;

/** Independent Project configuration: no Chat, Task or run schema dependencies. */
export const projectWakePolicySchema = z.strictObject({
  provider: wakeProviderSchema,
  configRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  model: z.string().trim().min(1).max(200),
  thresholdVersion: z.string().trim().min(1).max(80),
});
export type ProjectWakePolicy = z.infer<typeof projectWakePolicySchema>;
