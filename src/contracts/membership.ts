import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { leaseKeySchema } from "./lease";
import { machineIdSchema, positiveSafeIntegerSchema } from "./machine";
import type { ExecutionView } from "./remote";
import { WORKER_STALE_AFTER_MS } from "./worker";

const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));
const membershipRequestIdSchema = id(ID_PREFIXES.request);
const leaseMutationIdSchema = id(ID_PREFIXES.leaseMutation);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();

export const MEMBERSHIP_STATES = ["active", "detaching", "removed"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

/** `revocation` 由关联 receipt 派生：active=null，detaching=pending，正常完成=confirmed，force=unconfirmed。 */
export const MEMBERSHIP_REVOCATIONS = ["pending", "confirmed", "unconfirmed"] as const;
export type MembershipRevocation = (typeof MEMBERSHIP_REVOCATIONS)[number];

export const PENDING_FACT_KINDS = [
  "lease_fencing",
  "membership_detaching",
  "notice_undelivered",
] as const;
export type PendingFactKind = (typeof PENDING_FACT_KINDS)[number];

/** 只登记冻结结论命名的可引用事实；新增事实必须同时扩展这里与服务端投影。 */
export const PENDING_EVIDENCE = [
  "awaiting_ack",
  "delivery_unconfirmed",
  "run_not_running",
] as const;
export type PendingEvidence = (typeof PENDING_EVIDENCE)[number];

/**
 * 统一的待处理投影。`overdue` 只表示 `elapsedMs >= thresholdMs`，不推断 Worker 不在线；
 * `workerOnline` 复用当前连接的高水位/状态/lastSeen 规则，与 pending 年龄正交。
 */
export const pendingFactViewSchema = z
  .strictObject({
    kind: z.enum(PENDING_FACT_KINDS),
    since: timestampSchema,
    elapsedMs: nonnegativeSafeIntegerSchema,
    thresholdMs: z.literal(WORKER_STALE_AFTER_MS),
    overdue: z.boolean(),
    workerOnline: z.boolean(),
    evidence: z.enum(PENDING_EVIDENCE),
    canForceReclaim: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.overdue !== value.elapsedMs >= value.thresholdMs)
      ctx.addIssue({ code: "custom", message: "overdue 必须等于 elapsedMs 是否达到阈值" });
    if (value.kind === "notice_undelivered" && value.evidence === "awaiting_ack")
      ctx.addIssue({ code: "custom", message: "未投递通知只能引用投递或 run 事实" });
    if (value.kind !== "notice_undelivered" && value.evidence !== "awaiting_ack")
      ctx.addIssue({ code: "custom", message: "租约与移出待处理只能引用等待确认事实" });
  });
export type PendingFactView = z.infer<typeof pendingFactViewSchema>;

/** 服务端 `projectPendingFact(input, now)` 的输入：事实来自同一事务读取的行与当前连接。 */
export const pendingFactInputSchema = z.strictObject({
  kind: z.enum(PENDING_FACT_KINDS),
  since: timestampSchema,
  workerOnline: z.boolean(),
  evidence: z.enum(PENDING_EVIDENCE),
  canForceReclaim: z.boolean(),
});
export type PendingFactInput = z.infer<typeof pendingFactInputSchema>;

/**
 * 一行是一段加入生命周期。最新 epoch 用 PK 反向查；不要把只查 live 行的结果当作关系存在。
 * `pending` 只在 detaching 时有值，removed 的历史入口不再展示 pending。
 */
export const membershipViewSchema = z
  .strictObject({
    ...leaseKeySchema.shape,
    epoch: positiveSafeIntegerSchema,
    state: z.enum(MEMBERSHIP_STATES),
    joinedAt: timestampSchema,
    requestedAt: timestampSchema.nullable(),
    removedAt: timestampSchema.nullable(),
    removalMutationId: leaseMutationIdSchema.nullable(),
    revokedGeneration: nonnegativeSafeIntegerSchema.nullable(),
    revocation: z.enum(MEMBERSHIP_REVOCATIONS).nullable(),
    pending: pendingFactViewSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const active = value.state === "active";
    const detaching = value.state === "detaching";
    const removed = value.state === "removed";
    if (
      (active &&
        (value.requestedAt !== null ||
          value.removedAt !== null ||
          value.removalMutationId !== null ||
          value.revokedGeneration !== null ||
          value.revocation !== null ||
          value.pending !== null)) ||
      (detaching &&
        (value.requestedAt === null ||
          value.removalMutationId === null ||
          value.removedAt !== null ||
          value.revokedGeneration !== null ||
          value.revocation !== "pending" ||
          value.pending === null ||
          value.pending.kind !== "membership_detaching" ||
          value.pending.since !== value.requestedAt)) ||
      (removed &&
        (value.requestedAt === null ||
          value.removedAt === null ||
          value.revokedGeneration === null ||
          value.revocation === null ||
          value.revocation === "pending" ||
          value.pending !== null))
    ) {
      ctx.addIssue({ code: "custom", message: "membership 状态与移出字段、撤权派生不一致" });
    }
    if (
      (value.requestedAt !== null && Date.parse(value.requestedAt) < Date.parse(value.joinedAt)) ||
      (value.removedAt !== null &&
        (value.requestedAt === null || Date.parse(value.removedAt) < Date.parse(value.requestedAt)))
    ) {
      ctx.addIssue({ code: "custom", message: "membership 时间顺序不一致" });
    }
  });
export type MembershipView = z.infer<typeof membershipViewSchema>;

/** `authorityNow` 返回值：与读行同事务取得，不缓存到后续请求。 */
export interface AuthorityNow {
  generation: number;
  holderInstanceId: string | null;
  state: "free" | "active" | "draining";
}

/** 执行出处的最小事实；不能复制一个可变 owner。 */
export interface ExecutionOrigin {
  projectId: string;
  machineId: string;
  authorizationGeneration: number;
  holderInstanceId: string;
}

/** 移出输入。`confirm: true` 是服务端必需字面值，缺失/false 一律 `validation_failed`。 */
export const detachMachineInputSchema = z.strictObject({
  ...leaseKeySchema.shape,
  requestId: membershipRequestIdSchema,
  expectedEpoch: positiveSafeIntegerSchema,
  expectedRevision: positiveSafeIntegerSchema,
  expectedGeneration: nonnegativeSafeIntegerSchema,
  confirm: z.literal(true),
});
export type DetachInput = z.infer<typeof detachMachineInputSchema>;

/** 重加入只对最新 removed epoch 生效；不携带配置变更，配置修改走既有 save binding。 */
export const rejoinProjectMachineInputSchema = z.strictObject({
  ...leaseKeySchema.shape,
  requestId: membershipRequestIdSchema,
  expectedEpoch: positiveSafeIntegerSchema,
  expectedRevision: positiveSafeIntegerSchema,
  confirm: z.literal(true),
});
export type RejoinInput = z.infer<typeof rejoinProjectMachineInputSchema>;

/** 新 holder 的发现入口输入：Project 由宿主上下文注入，不来自调用方。 */
export const holderExecutionListInputSchema = z.strictObject({
  machineId: machineIdSchema,
  limit: positiveSafeIntegerSchema.max(100).default(20),
  before: z.string().min(1).max(256).optional(),
});
export type HolderExecutionListInput = z.infer<typeof holderExecutionListInputSchema>;

export type HolderExecutionListView = {
  executions: ExecutionView[];
  nextCursor: string | null;
};
