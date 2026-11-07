import { z } from "zod";

/**
 * I-P8b 挂靠超时与申请遇阻等待的唯一数值来源（`orchestrate/sprout-mio-p8/params.md` T1–T12、N1–N8）。
 *
 * 两个超时都是真实墙钟，因此必须可注入：项目行可以覆盖 `timeoutMs` / `escalationMs`，
 * 下限 1 秒，好让集成线把 30 分钟 + 2 小时压到秒级跑真实链路（默认值才是产品值）。
 */
export const LEASE_TIMEOUT_DEFAULT_MS = 1_800_000;
/** T9：owner 是 Agent 且超时后仍未处理，再过这么久升级给人类。 */
export const LEASE_ESCALATION_DEFAULT_MS = 7_200_000;
/** 只做「不能是 0 或负数」的护栏：真实墙钟下限压到 1 秒，集成线才能验收。 */
export const LEASE_TIMEOUT_MIN_MS = 1_000;

const leaseTimeoutMsSchema = z
  .number()
  .int()
  .min(LEASE_TIMEOUT_MIN_MS)
  .max(Number.MAX_SAFE_INTEGER);

/** 挂靠超时时限；`escalationMs` 是「超时之后再等多久升级」，不是绝对时刻。 */
export const leaseTimeoutsSchema = z.strictObject({
  timeoutMs: leaseTimeoutMsSchema,
  escalationMs: leaseTimeoutMsSchema,
});
export type LeaseTimeouts = z.infer<typeof leaseTimeoutsSchema>;

/** 项目行没有这段 JSON（老数据）或写坏了都退回这里，读默认值而不是报错。 */
export const DEFAULT_LEASE_TIMEOUTS = Object.freeze({
  timeoutMs: LEASE_TIMEOUT_DEFAULT_MS,
  escalationMs: LEASE_ESCALATION_DEFAULT_MS,
} satisfies LeaseTimeouts);

export function resolveLeaseTimeouts(value: unknown): LeaseTimeouts {
  const parsed = leaseTimeoutsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_LEASE_TIMEOUTS;
}

/**
 * N2：等待时长由申请方 Agent 自己作为工具参数传入，建议 5 分钟，
 * 超过 1 小时一律钳到 1 小时。**不提供按 Project 配置的参数**（N7）。
 */
export const LEASE_WAIT_SUGGESTED_MS = 300_000;
export const LEASE_WAIT_MAX_MS = 3_600_000;
export const LEASE_WAIT_MIN_MS = 1_000;

export function clampLeaseWaitMs(requestedMs?: number): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs)) return LEASE_WAIT_SUGGESTED_MS;
  return Math.min(Math.max(Math.trunc(requestedMs), LEASE_WAIT_MIN_MS), LEASE_WAIT_MAX_MS);
}

/**
 * N4：到点仍拿不到就**同步返回「失败 + 原因」**，不另建投递通道，由 Agent 自己决定当前 run
 * 是否提前中止并汇报——平台不代为决定。
 */
export const leaseWaitFailureSchema = z.enum(["timed_out", "identity_busy"]);
export type LeaseWaitFailure = z.infer<typeof leaseWaitFailureSchema>;

/**
 * 挂靠超时的只读事实，随挂靠视图一起给出（T6/T11）。
 *
 * T6：超时**只加只读标记，绝不释放租约**——占用与权限不变，这里的字段全是观察结果，
 * 没有任何一个可以被用来改机器归属。
 */
export const leaseEscrowTimeoutSchema = z.strictObject({
  /** 超时截止 = 挂靠被接受时刻（`escrowedAt`）+ `timeoutMs`（T1/T2）。 */
  deadlineAt: z.iso.datetime(),
  /** 只发一次的提醒已经产生的时刻；null 表示还没提醒（T5）。 */
  notifiedAt: z.iso.datetime().nullable(),
  /** 升级人类的时刻；有值即 owner 的自动尝试已暂停（T9）。 */
  escalatedAt: z.iso.datetime().nullable(),
  /** 已超时且尚未被处理：常驻的「超时待处理」标记（T5/T6），处理方式是领取、撤销或强制收回。 */
  awaitingHandling: z.boolean(),
  /** 升级后系统不再对该 owner 自动尝试（T9），等待人类决策。 */
  ownerAutoAttemptsPaused: z.boolean(),
});
export type LeaseEscrowTimeout = z.infer<typeof leaseEscrowTimeoutSchema>;
