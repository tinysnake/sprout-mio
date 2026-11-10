import { clampLeaseWaitMs, type LeaseWaitFailure } from "../contracts/lease-timeout";

/**
 * I-P8b「申请遇阻等待」（N1–N8）。
 *
 * 这是**阻塞当前 run** 的等待（N5），不是挂起/恢复：调用方一直等到拿到、到点或不再有对象为止。
 * 等待期间**不抢占、不自动释放、不向持有者发送任何请求**（N3）——它只读租约视图，
 * 对持有者完全不可见。
 */

/** 判定等待要看到的最小租约事实；直接用 `LeaseView` 契约即可满足。 */
export type LeaseWaitView = {
  readonly state: "free" | "held" | "fencing";
  readonly holderInstanceId: string | null;
  readonly escrow: {
    readonly escrowId: string;
    readonly state: string;
    readonly targetAgentProfileId: string | null;
    readonly escrowedByInstanceId: string;
  } | null;
};

export type LeaseWaitTarget =
  | {
      readonly kind: "wait";
      /** 租约仍被其他分身持有。 */
      readonly reason: "held_by_other";
      readonly holderInstanceId: string;
    }
  | {
      readonly kind: "wait";
      /** 仍挂在挂靠中，且有可定位对象（挂靠本身或它的目标）。 */
      readonly reason: "escrowed";
      readonly escrowId: string;
    }
  | { readonly kind: "no_target"; readonly reason: "free" | "already_held" };

/**
 * N1：只有「明确需要这台 Machine，但租约仍被其他分身持有」或「仍挂在挂靠中且有可定位对象」
 * 才进入等待。没有明确对象时直接告知申请方，不进入等待。
 */
export function leaseWaitTarget(view: LeaseWaitView, requesterInstanceId: string): LeaseWaitTarget {
  if (view.holderInstanceId === requesterInstanceId)
    return { kind: "no_target", reason: "already_held" };
  if (view.escrow) return { kind: "wait", reason: "escrowed", escrowId: view.escrow.escrowId };
  if (view.state !== "free" && view.holderInstanceId !== null)
    return { kind: "wait", reason: "held_by_other", holderInstanceId: view.holderInstanceId };
  return { kind: "no_target", reason: "free" };
}

export type LeaseWaitResult<View extends LeaseWaitView> =
  | { readonly ok: true; readonly lease: View }
  | { readonly ok: false; readonly reason: LeaseWaitFailure };

export type LeaseWaitDeps<View extends LeaseWaitView> = {
  /** 只读租约视图。实现里不做任何写入。允许异步实现（工具链上是 `lease_get` 请求）。 */
  readonly readLease: () => View | Promise<View>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
};

/**
 * 同一个身份同时只允许一次等待（N8：等待期间该身份不接其他工作）。
 * 第二次进入直接得到 `identity_busy`，而不是两个 run 一起空等。
 */
const waitingIdentities = new Set<string>();

export function leaseWaitBusy(instanceId: string): boolean {
  return waitingIdentities.has(instanceId);
}

export const DEFAULT_LEASE_WAIT_POLL_MS = 1_000;

/**
 * 阻塞等待到「拿到租约」「不再有对象」或时限到点。
 *
 * 时限由申请方 Agent 自己作为工具参数传入（N2）：建议 5 分钟，超过 1 小时一律钳到 1 小时；
 * 这里没有 Project 级配置（N7）。`now`/`sleep` 是注入的，测试可以传入短时长与假时钟。
 */
export async function waitForLease<View extends LeaseWaitView>(input: {
  readonly requesterInstanceId: string;
  readonly requestedMs?: number;
  readonly pollMs?: number;
  readonly deps: LeaseWaitDeps<View>;
}): Promise<LeaseWaitResult<View>> {
  const { deps } = input;
  if (waitingIdentities.has(input.requesterInstanceId))
    return { ok: false, reason: "identity_busy" };
  waitingIdentities.add(input.requesterInstanceId);
  try {
    const budgetMs = clampLeaseWaitMs(input.requestedMs);
    const pollMs = Math.max(1, input.pollMs ?? DEFAULT_LEASE_WAIT_POLL_MS);
    const deadline = deps.now().getTime() + budgetMs;
    for (;;) {
      const lease = await deps.readLease();
      const target = leaseWaitTarget(lease, input.requesterInstanceId);
      if (target.kind === "no_target") return { ok: true, lease };
      const remaining = deadline - deps.now().getTime();
      if (remaining <= 0) return { ok: false, reason: "timed_out" };
      await deps.sleep(Math.min(pollMs, remaining));
    }
  } finally {
    waitingIdentities.delete(input.requesterInstanceId);
  }
}
