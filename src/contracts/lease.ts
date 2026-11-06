import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema, positiveSafeIntegerSchema } from "./machine";

const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));
const instanceIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.instance));
const mutationIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.leaseMutation));
const chatIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const escrowIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.leaseEscrow));
const generationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();
export const leaseKeySchema = z.strictObject({
  projectId: projectIdSchema,
  machineId: machineIdSchema,
});
/**
 * 挂靠事实（escrow）。挂靠中的租约仍然是占用状态（machine_lease 仍是 held、持有者仍是发起者），
 * 变化的只是操作权：发起者的授权变成 escrowed，于是它下命令会拿到 lease_not_holder。
 *
 * 一次挂靠一行：领取或撤销会关掉这一行（state 转终态），新持有者可以再次挂靠，历史不被覆盖。
 * `claimedGeneration` 是领取产生的新代次，必大于 `escrowGeneration`（挂靠生效的那一代）。
 */
export const leaseEscrowViewSchema = leaseKeySchema
  .extend({
    escrowId: escrowIdSchema,
    state: z.enum(["escrowed", "claimed", "cancelled", "superseded"]),
    chatId: chatIdSchema,
    targetAgentProfileId: agentProfileIdSchema.nullable(),
    escrowedByInstanceId: instanceIdSchema,
    escrowedAt: timestampSchema,
    escrowGeneration: positiveSafeIntegerSchema,
    claimedByInstanceId: instanceIdSchema.nullable(),
    claimedAt: timestampSchema.nullable(),
    claimedGeneration: positiveSafeIntegerSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const claimed = value.state === "claimed";
    const live = value.state === "escrowed";
    if (
      claimed !== (value.claimedByInstanceId !== null) ||
      claimed !== (value.claimedAt !== null) ||
      claimed !== (value.claimedGeneration !== null) ||
      (live && value.claimedGeneration !== null) ||
      (value.claimedGeneration !== null && value.claimedGeneration <= value.escrowGeneration) ||
      (value.claimedAt !== null && Date.parse(value.claimedAt) < Date.parse(value.escrowedAt))
    ) {
      ctx.addIssue({ code: "custom", message: "挂靠事实与领取者、领取时间或代次不一致" });
    }
  });
export const leaseViewSchema = leaseKeySchema
  .extend({
    generation: generationSchema,
    state: z.enum(["free", "held", "fencing"]),
    holderInstanceId: instanceIdSchema.nullable(),
    changedAt: timestampSchema,
    pendingMutationId: mutationIdSchema.nullable(),
    /** 活跃挂靠（state=escrowed 的那一行）；没有则为 null。租约没有被释放。 */
    escrow: leaseEscrowViewSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.state === "free") !== (value.holderInstanceId === null) ||
      (value.state !== "free" && value.generation === 0) ||
      (value.state === "fencing") !== (value.pendingMutationId !== null) ||
      (value.escrow !== null &&
        (value.state === "free" ||
          value.escrow.state !== "escrowed" ||
          value.escrow.escrowedByInstanceId !== value.holderInstanceId))
    ) {
      ctx.addIssue({ code: "custom", message: "租约状态与持有者、代次、待完成动作或挂靠不一致" });
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
// Force is a separate Human command; it is deliberately absent from Agent mutation inputs.
export const forceReclaimLeaseInputSchema = leaseKeySchema.extend({
  action: z.literal("force_reclaim"),
  mutationId: mutationIdSchema,
  expectedGeneration: positiveSafeIntegerSchema,
  confirm: z.literal(true),
});
export const forcedReclaimSchema = z.strictObject({
  mutationId: mutationIdSchema,
  supersededMutationId: mutationIdSchema,
  forcedByUserId: z.string().min(1),
  forcedAt: timestampSchema,
});
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
    forcedReclaim: forcedReclaimSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const completed = value.state === "completed";
    if (
      value.forcedReclaim &&
      (!completed ||
        value.forcedReclaim.forcedAt !== value.completedAt ||
        value.forcedReclaim.mutationId === value.forcedReclaim.supersededMutationId ||
        (value.forcedReclaim.mutationId !== value.mutationId &&
          value.forcedReclaim.supersededMutationId !== value.mutationId) ||
        (value.forcedReclaim.mutationId === value.mutationId && value.action !== "reclaim"))
    ) {
      ctx.addIssue({ code: "custom", message: "强制收回审计事实与动作收据不一致" });
    }
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
/**
 * 挂靠请求：把租约挂到本 Project 的某个 Group（`targetAgentProfileId` 为空）
 * 或该 Group 内的某个 Agent profile。`chatId` 是 Public Channel 时同样成立；DM 不被支持。
 */
export const leaseEscrowInputSchema = z.strictObject({
  ...leaseKeySchema.shape,
  action: z.literal("escrow"),
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
  expectedGeneration: positiveSafeIntegerSchema,
  chatId: chatIdSchema,
  targetAgentProfileId: agentProfileIdSchema.optional(),
});
/** 领取：领取者凭自己的身份（instanceId）取代持有者，`escrowId` 指定要领取的那次挂靠。 */
export const leaseClaimInputSchema = z.strictObject({
  ...leaseKeySchema.shape,
  action: z.literal("claim"),
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
  expectedGeneration: positiveSafeIntegerSchema,
  escrowId: escrowIdSchema,
});
/** 撤销：只有发起挂靠的分身能撤销，租约回到发起者手里（不释放 Machine）。 */
export const leaseEscrowCancelInputSchema = z.strictObject({
  ...leaseKeySchema.shape,
  action: z.literal("escrow_cancel"),
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
  expectedGeneration: positiveSafeIntegerSchema,
  escrowId: escrowIdSchema,
});
export const leaseEscrowCommandInputSchema = z.discriminatedUnion("action", [
  leaseEscrowInputSchema,
  leaseClaimInputSchema,
  leaseEscrowCancelInputSchema,
]);
/** 挂靠/领取/撤销都是同步完成的，返回动作之后的新事实。 */
export const leaseEscrowResultSchema = z.strictObject({
  lease: leaseViewSchema,
  escrow: leaseEscrowViewSchema,
});
export type ForceReclaimLeaseInput = z.infer<typeof forceReclaimLeaseInputSchema>;
export type LeaseKey = z.infer<typeof leaseKeySchema>;
export type LeaseView = z.infer<typeof leaseViewSchema>;
export type LeaseMutationInput = z.infer<typeof leaseMutationInputSchema>;
export type LeaseMutationView = z.infer<typeof leaseMutationViewSchema>;
export type LeaseReadInput = z.infer<typeof leaseReadInputSchema>;
export type LeaseEscrowInput = z.infer<typeof leaseEscrowInputSchema>;
export type LeaseClaimInput = z.infer<typeof leaseClaimInputSchema>;
export type LeaseEscrowCancelInput = z.infer<typeof leaseEscrowCancelInputSchema>;
export type LeaseEscrowCommandInput = z.infer<typeof leaseEscrowCommandInputSchema>;
export type LeaseEscrowView = z.infer<typeof leaseEscrowViewSchema>;
export type LeaseEscrowResult = z.infer<typeof leaseEscrowResultSchema>;
