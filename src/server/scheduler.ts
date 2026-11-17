import {
  advanceCrewResources,
  deliverCrewResourceEvents,
  reconcileCrewResources,
} from "../domain/crew-resource";
import { deliverPendingDelegations, reconcileDelegations } from "../domain/delegation";
import { nextLeaseTimeoutDueAt, sweepLeaseEscrowTimeouts } from "../domain/lease-timeout";
import { nextRunAttentionDueAt, sweepRunAttention } from "../domain/run-attention";
import { onSchedulerChange } from "../domain/scheduler-signal";

export type SchedulerClock = {
  now: () => Date;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};
const clock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Project 运行时的后台扫描器：只处理有时限的系统动作——
 * 运行注意力提醒、租约超时提醒、委派与 Crew 资源投递。
 * 对话本身没有定时判定，消息到来时由各自的写入路径直接推进。
 */
export function createScheduler(
  options: {
    clock?: SchedulerClock;
    workerId?: string;
    onError?: (error: unknown) => void;
  } = {},
) {
  const time = options.clock ?? clock;
  let timer: unknown,
    heartbeat: unknown,
    started = false,
    busy = false,
    unsubscribe: (() => void) | undefined;
  const report = options.onError ?? ((error) => console.error("[scheduler]", error));

  function rearm() {
    if (!started) return;
    if (timer !== undefined) {
      time.clearTimeout(timer);
      timer = undefined;
    }
    const dueTimes = [nextLeaseTimeoutDueAt(), nextRunAttentionDueAt()].filter(
      (due): due is number => due !== null,
    );
    const next = dueTimes.length ? Math.min(...dueTimes) : null;
    if (next !== null)
      timer = time.setTimeout(
        () => {
          timer = undefined;
          void advance().catch(report);
        },
        Math.min(2_147_483_647, Math.max(0, next - time.now().getTime())),
      );
  }

  async function advance() {
    if (!started || busy) return;
    busy = true;
    try {
      const now = time.now();
      sweepRunAttention(now);
      reconcileDelegations();
      reconcileCrewResources(new Date(now));
      advanceCrewResources();
      deliverCrewResourceEvents();
      deliverPendingDelegations();
      sweepLeaseEscrowTimeouts(now);
    } finally {
      busy = false;
      rearm();
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = onSchedulerChange(rearm);
      // 兜底：即使某个 signal 丢失，也要定期检查到期的系统提醒。
      heartbeat = time.setInterval?.(() => {
        void advance().catch(report);
      }, 15_000);
      void advance().catch(report);
    },
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) time.clearTimeout(timer);
      timer = undefined;
      if (heartbeat !== undefined) time.clearInterval?.(heartbeat);
      heartbeat = undefined;
    },
    advance,
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
