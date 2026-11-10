import type { LeaseEscrowView } from "../../contracts/lease";
import type { StatusTone } from "./machine-view";

/**
 * 挂靠超时的呈现映射。输入只有 `leaseEscrowViewSchema.timeout`（只读事实），
 * 这里不做判定，也不产生新的领域状态：挂靠超时**不是**释放，超时待处理期间
 * 租约占用与权限都不变，所以这里给出的任何文案都不能读成「空闲」或「已收回」。
 */

export type LeaseTimeoutLabel = {
  readonly label: string;
  readonly tone: StatusTone;
};

export type LeaseTimeoutPhase = "none" | "awaiting" | "escalated";

/**
 * 超时相位。`escalatedAt` 非空即已升级（domain 里它等价于 owner 自动尝试已暂停）；
 * `awaitingHandling` 表示已过挂靠时限且挂靠还活着。
 */
export function leaseTimeoutPhase(timeout: LeaseEscrowView["timeout"]): LeaseTimeoutPhase {
  if (timeout.escalatedAt !== null) return "escalated";
  return timeout.awaitingHandling ? "awaiting" : "none";
}

export const LEASE_TIMEOUT_LABELS: Record<Exclude<LeaseTimeoutPhase, "none">, LeaseTimeoutLabel> = {
  awaiting: { label: "超时未处理", tone: "warning" },
  escalated: { label: "已升级给人类", tone: "danger" },
};

/** 状态位后缀：挂靠中的租约必须一眼看出「它超时了、还没人处理」。 */
export function leaseTimeoutSuffix(timeout: LeaseEscrowView["timeout"]): string {
  const phase = leaseTimeoutPhase(timeout);
  return phase === "none" ? "" : ` · ${LEASE_TIMEOUT_LABELS[phase].label}`;
}
