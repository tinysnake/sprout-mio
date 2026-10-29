import { z } from "zod";
import { runIdSchema } from "./agent-run";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema, positiveSafeIntegerSchema } from "./machine";
import { REMOTE_EXECUTION_STATES } from "./remote";

const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));
const projectIdSchema = id(ID_PREFIXES.project);
const instanceIdSchema = id(ID_PREFIXES.instance);
const chatIdSchema = id(ID_PREFIXES.chat);
const executionIdSchema = id(ID_PREFIXES.execution);
const leaseMutationIdSchema = id(ID_PREFIXES.leaseMutation);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();

/** 资源撤销通知的根因。detach 引起的收回固定用 `machine_removed`，不叠加 `lease_reclaimed`。 */
export const RUN_RESOURCE_NOTICE_KINDS = [
  "lease_handed_off",
  "lease_released",
  "lease_reclaimed",
  "machine_removed",
] as const;
export type RunResourceNoticeKind = (typeof RUN_RESOURCE_NOTICE_KINDS)[number];

export const NOTICE_REVOCATIONS = ["pending", "confirmed", "unconfirmed"] as const;
export type NoticeRevocation = (typeof NOTICE_REVOCATIONS)[number];

export const noticeIdSchema = id(ID_PREFIXES.notice);

/** `machine_removed` 的 cause 指向一段 membership 生命周期，不用租约 receipt 冒充。 */
export function membershipCauseId(projectId: string, machineId: string, epoch: number): string {
  return `membership:${projectId}:${machineId}:${epoch}`;
}

const membershipCauseIdSchema = z
  .string()
  .regex(
    /^membership:prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:mch_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$/,
  );

const noticeExecutionSchema = z.strictObject({
  executionId: executionIdSchema,
  lastKnownState: z.enum(REMOTE_EXECUTION_STATES),
});

const noticePayloadBase = {
  machineId: machineIdSchema,
  // 本次撤权所依据的租约代次；0 只可能出现在从未建立租约的移出。
  generation: nonnegativeSafeIntegerSchema,
  executions: z
    .array(noticeExecutionSchema)
    .max(256)
    .refine(
      (values) => new Set(values.map((value) => value.executionId)).size === values.length,
      "受影响的执行不能重复",
    ),
  revocation: z.enum(NOTICE_REVOCATIONS),
  targetInstanceId: instanceIdSchema.optional(),
  membershipEpoch: positiveSafeIntegerSchema.optional(),
};

/**
 * 通知 payload 是 cause 的事实快照：只命名资源、代次与受影响执行，不含命令、
 * 文件内容、token 或原始日志。判别联合按 `kind` 分开，投递内容不会因为后续
 * 收到确认而原地改写；确认从租约与 membership 事实视图查询。
 */
export const runResourceNoticePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("lease_handed_off"),
    ...noticePayloadBase,
  }),
  z.strictObject({
    kind: z.literal("lease_released"),
    ...noticePayloadBase,
  }),
  z.strictObject({
    kind: z.literal("lease_reclaimed"),
    ...noticePayloadBase,
  }),
  z.strictObject({
    kind: z.literal("machine_removed"),
    ...noticePayloadBase,
  }),
]);
export type RunResourceNoticePayload = z.infer<typeof runResourceNoticePayloadSchema>;

export const runResourceNoticeSchema = z
  .strictObject({
    id: noticeIdSchema,
    projectId: projectIdSchema,
    machineId: machineIdSchema,
    runId: runIdSchema,
    instanceId: instanceIdSchema,
    chatId: chatIdSchema,
    kind: z.enum(RUN_RESOURCE_NOTICE_KINDS),
    causeId: z.string().min(1).max(200),
    payload: runResourceNoticePayloadSchema,
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.payload.kind !== value.kind)
      ctx.addIssue({ code: "custom", message: "通知 kind 与 payload 根因不一致" });
    if (value.payload.machineId !== value.machineId)
      ctx.addIssue({ code: "custom", message: "通知 payload 的 Machine 与行事实不一致" });
    if (value.deliveredAt !== null && Date.parse(value.deliveredAt) < Date.parse(value.createdAt))
      ctx.addIssue({ code: "custom", message: "通知投递时间不能早于创建时间" });
    const causeValid =
      value.kind === "machine_removed"
        ? membershipCauseIdSchema.safeParse(value.causeId).success
        : leaseMutationIdSchema.safeParse(value.causeId).success;
    if (!causeValid) ctx.addIssue({ code: "custom", message: "通知 cause 与根因类型不匹配" });
    if (value.kind === "machine_removed" && value.payload.membershipEpoch === undefined)
      ctx.addIssue({ code: "custom", message: "machine_removed 通知必须带 membership epoch" });
  });
export type RunResourceNotice = z.infer<typeof runResourceNoticeSchema>;

/** `pendingRunNotices` 的输入：只按 run 拉取尚未投递的持久 outbox，不扫描租约历史。 */
export const pendingRunNoticesInputSchema = z.strictObject({ runId: runIdSchema });
export type PendingRunNoticesInput = z.infer<typeof pendingRunNoticesInputSchema>;
