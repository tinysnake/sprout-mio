import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema, positiveSafeIntegerSchema } from "./machine";

const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));
const instanceIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.instance));
const mutationIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.leaseMutation));
const generationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();
export const leaseKeySchema = z.strictObject({
  projectId: projectIdSchema,
  machineId: machineIdSchema,
});
export const leaseViewSchema = leaseKeySchema
  .extend({
    generation: generationSchema,
    state: z.enum(["free", "held", "fencing"]),
    holderInstanceId: instanceIdSchema.nullable(),
    changedAt: timestampSchema,
    pendingMutationId: mutationIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.state === "free") !== (value.holderInstanceId === null) ||
      (value.state !== "free" && value.generation === 0) ||
      (value.state === "fencing") !== (value.pendingMutationId !== null)
    ) {
      ctx.addIssue({ code: "custom", message: "租约状态与持有者、代次或待完成动作不一致" });
    }
  });
const mutationBase = {
  ...leaseKeySchema.shape,
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
};
export const leaseMutationInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...mutationBase,
    action: z.literal("acquire"),
    expectedGeneration: generationSchema,
  }),
  z.strictObject({
    ...mutationBase,
    action: z.literal("release"),
    expectedGeneration: positiveSafeIntegerSchema,
  }),
  z.strictObject({
    ...mutationBase,
    action: z.literal("handoff"),
    expectedGeneration: positiveSafeIntegerSchema,
    targetInstanceId: instanceIdSchema,
  }),
  z.strictObject({
    ...mutationBase,
    action: z.literal("reclaim"),
    expectedGeneration: positiveSafeIntegerSchema,
    confirm: z.literal(true),
  }),
]);
export const leaseMutationViewSchema = leaseKeySchema
  .extend({
    mutationId: mutationIdSchema,
    action: z.enum(["acquire", "release", "handoff", "reclaim"]),
    state: z.enum(["pending", "completed"]),
    expectedGeneration: generationSchema,
    completedGeneration: generationSchema.nullable(),
    targetInstanceId: instanceIdSchema.nullable(),
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const completed = value.state === "completed";
    if (
      (value.action === "handoff") !== (value.targetInstanceId !== null) ||
      (value.action !== "acquire" && value.expectedGeneration === 0) ||
      (!completed &&
        (value.action === "acquire" ||
          value.completedAt !== null ||
          value.completedGeneration !== null)) ||
      (completed &&
        (value.completedAt === null ||
          value.completedGeneration === null ||
          Date.parse(value.completedAt) < Date.parse(value.createdAt) ||
          !(
            value.completedGeneration === value.expectedGeneration + 1 ||
            (value.action === "acquire" && value.completedGeneration === value.expectedGeneration)
          )))
    ) {
      ctx.addIssue({ code: "custom", message: "租约动作收据不一致" });
    }
  });
export const leaseReadInputSchema = leaseKeySchema.extend({
  mutationId: mutationIdSchema.optional(),
});
export type LeaseKey = z.infer<typeof leaseKeySchema>;
export type LeaseView = z.infer<typeof leaseViewSchema>;
export type LeaseMutationInput = z.infer<typeof leaseMutationInputSchema>;
export type LeaseMutationView = z.infer<typeof leaseMutationViewSchema>;
export type LeaseReadInput = z.infer<typeof leaseReadInputSchema>;
