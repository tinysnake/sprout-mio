import type { LeaseEscrowView } from "../../contracts/lease";
import type { LeaseWaitFailure } from "../../contracts/lease-timeout";
import type { StatusTone } from "./machine-view";
import { formatMoment } from "./machine-view";

/**
 * 挂靠超时与申请遇阻等待的呈现映射。
 *
 * 输入只有 `leaseEscrowViewSchema.timeout`（功能线新增的只读事实）与
 * `leaseWaitFailureSchema`。这里不做判定，也不产生新的领域状态：挂靠超时**不是**释放，
 * 超时待处理期间租约占用与权限都不变，所以这里给出的任何文案都不能读成「空闲」或「已收回」。
 *
 * 两件事必须在界面上分开（很容易混淆）：
 * - 挂靠时限：默认 30 分钟、可按 Project 覆盖，由 `deadlineAt - escrowedAt` 反推；
 * - 申请遇阻等待：时长由发起等待的分身自己指定（建议 5 分钟、上限 1 小时），界面上没有它的倒计时。
 */

export type LeaseTimeoutLabel = {
  readonly label: string;
  readonly detail: string;
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
  awaiting: {
    label: "超时未处理",
    detail: "已过挂靠时限，还没有人处理。租约占用与权限保持不变，不是已收回。",
    tone: "warning",
  },
  escalated: {
    label: "已升级给人类",
    // T9：升级只发 chat 消息；「自动尝试已暂停」单独一行，不在这里重复一遍。
    detail: "owner 过了升级时限仍未处理，系统已升级给人类（挂靠发起者与 Project owner）。",
    tone: "danger",
  },
};

/**
 * 状态位后缀：挂靠中的租约必须一眼看出「它超时了、还没人处理」，
 * 所以超时事实并入状态位，而不是藏在别处。
 */
export function leaseTimeoutSuffix(timeout: LeaseEscrowView["timeout"]): string {
  const phase = leaseTimeoutPhase(timeout);
  return phase === "none" ? "" : ` · ${LEASE_TIMEOUT_LABELS[phase].label}`;
}

/**
 * 挂靠时限（毫秒）：`deadlineAt` 是 `escrowedAt + timeoutMs` 的结果，
 * 两者都是契约事实，所以这里不假定 30 分钟这个默认值。
 */
export function leaseTimeoutMs(escrow: Pick<LeaseEscrowView, "escrowedAt" | "timeout">): number {
  return new Date(escrow.timeout.deadlineAt).getTime() - new Date(escrow.escrowedAt).getTime();
}

/** 升级时限（毫秒）：只在已升级的挂靠上有值，`escalatedAt - deadlineAt`。 */
export function leaseEscalationMs(escrow: Pick<LeaseEscrowView, "timeout">): number | null {
  const escalatedAt = escrow.timeout.escalatedAt;
  if (escalatedAt === null) return null;
  return new Date(escalatedAt).getTime() - new Date(escrow.timeout.deadlineAt).getTime();
}

/** 与 domain 的 `durationText` 同一套说法的呈现版；UI 侧不 import 域层（会把 db 拖进浏览器包）。 */
export function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${ms} 毫秒`;
}

/** 提醒投递事实：T4 的提醒是一条 chat 消息，投递成功与否都只影响唤醒重试。 */
export function timeoutNoticeText(timeout: LeaseEscrowView["timeout"]): string {
  return timeout.notifiedAt === null
    ? "提醒尚未发出"
    : `提醒已发送（${formatMoment(timeout.notifiedAt)}）`;
}

/**
 * T11：申请方等待中的「保留原因」。等待的对象与原因都取自租约自身的挂靠事实，
 * 不推断谁在等，也不列出人类账号细节。
 */
export function leaseWaitReason(
  escrow: Pick<LeaseEscrowView, "state" | "timeout">,
): LeaseTimeoutLabel | null {
  if (escrow.state !== "escrowed") return null;
  const phase = leaseTimeoutPhase(escrow.timeout);
  // 保留原因里不出现「空闲」：超时的挂靠是「还被占着、等 owner 处理」，不是没人用。
  if (phase === "escalated")
    return {
      label: "挂靠已升级，等人类决定",
      detail: "租约仍由原持有者占着，申请方拿不到；自动尝试已暂停，只有人类能推进。",
      tone: "danger",
    };
  if (phase === "awaiting")
    return {
      label: "挂靠超时未处理，租约仍被占用",
      detail: "申请方拿不到这台 Machine，要等 owner 处理完挂靠。",
      tone: "warning",
    };
  return {
    label: "挂靠待处理，租约仍被占用",
    detail: "申请方拿不到这台 Machine，因为操作权已经交给挂靠目标，还没有人领取或撤销。",
    tone: "muted",
  };
}

/** N4/N6：等到时限仍被占用，或该身份已经在等待中，两者都由发起等待的 agent 自决。 */
export const LEASE_WAIT_FAILURE_LABELS: Record<LeaseWaitFailure, LeaseTimeoutLabel> = {
  timed_out: {
    label: "等到时限仍被占用",
    detail: "等待到发起方自己指定的时限，租约仍被占用；是否再等由发起等待的分身决定。",
    tone: "warning",
  },
  identity_busy: {
    label: "该身份已在等待中",
    detail: "同一个身份此刻已经阻塞在一个等待上；同一个身份不会有两份等待。",
    tone: "muted",
  },
};

/** 把两种时限的差别写成一句可以直接放在界面上的话，避免被读成同一个倒计时。 */
export function leaseTimingNotes(escrow: Pick<LeaseEscrowView, "escrowedAt" | "timeout">): {
  readonly timeout: string;
  readonly wait: string;
} {
  const escalation = leaseEscalationMs(escrow);
  return {
    timeout: `挂靠时限 ${durationText(leaseTimeoutMs(escrow))}（可按 Project 覆盖），${timeoutNoticeText(escrow.timeout)}${escalation === null ? "" : `；升级时限 ${durationText(escalation)}`}。`,
    wait: "申请遇阻等待的时长由发起等待的分身自己指定（建议 5 分钟、上限 1 小时），与挂靠时限不是同一个倒计时。",
  };
}
