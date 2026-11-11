import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { config } from "../lib/config";
import {
  claimDueEvaluation,
  onScheduleChange,
  one,
  recoverSchedules,
  scanChatSchedules,
  type SchedulerContext,
} from "../domain/chat-schedule";
import {
  bindPendingDeliveries,
  evaluateClaim,
  type EvaluateWake,
} from "../domain/continuation-delivery";
import { drainContinuationAborts } from "../domain/chat-continuation";
import { claimDueMessageWake, evaluateMessageClaim } from "../domain/message-wake";
import { nextLeaseTimeoutDueAt, sweepLeaseEscrowTimeouts } from "../domain/lease-timeout";
import { nextRunAttentionDueAt, sweepRunAttention } from "../domain/run-attention";

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
const globalState = globalThis as typeof globalThis & { sproutWakeEvaluator?: EvaluateWake };
/** Integration wires judge's result-only adapter here. No fallback to another provider is allowed. */
export function installWakeEvaluator(evaluateWake: EvaluateWake) {
  globalState.sproutWakeEvaluator = evaluateWake;
}
export function createContinuationScheduler(
  options: {
    clock?: SchedulerClock;
    evaluateWake?: EvaluateWake;
    abort?: (runId: string) => boolean;
    workerId?: string;
    onError?: (error: unknown) => void;
  } = {},
) {
  const time = options.clock ?? clock,
    workerId = options.workerId ?? randomUUID();
  let timer: unknown,
    heartbeat: unknown,
    started = false,
    busy = false,
    generation = 0,
    unsubscribe: (() => void) | undefined;
  const inflight = new Set<Promise<void>>();
  const report = options.onError ?? ((error) => console.error("[continuation-scheduler]", error));
  function rearm() {
    if (!started) return;
    if (timer !== undefined) {
      time.clearTimeout(timer);
      timer = undefined;
    }
    // No assigned Task and no pending transport retry means no Task timer at all.
    const scheduleDue =
      (config.SPROUT_CONTINUATION_ENABLED
        ? one<{ due: number | null }>(
            "SELECT min(due) AS due FROM (SELECT next_due_at AS due FROM chat_schedule WHERE next_due_at IS NOT NULL UNION ALL SELECT next_attempt_at AS due FROM continuation_delivery WHERE state='pending' AND next_attempt_at IS NOT NULL UNION ALL SELECT due_at AS due FROM chat_message_wake UNION ALL SELECT next_attempt_at AS due FROM wake_evaluation WHERE source='message' AND state='retry_wait' AND next_attempt_at IS NOT NULL)",
          )?.due
        : null) ?? null;
    const leaseDue = config.SPROUT_CONTINUATION_ENABLED ? nextLeaseTimeoutDueAt() : null;
    const dueTimes = [scheduleDue, leaseDue, nextRunAttentionDueAt()].filter(
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
      if (!config.SPROUT_CONTINUATION_ENABLED) return;
      scanChatSchedules(now);
      drainContinuationAborts(now, options.abort ?? (() => false));
      bindPendingDeliveries(now);
      sweepLeaseEscrowTimeouts(now);
      // Claims are synchronous; provider requests run concurrently without holding the writer lock.
      for (let n = 0; n < 100; n++) {
        const ctx: SchedulerContext = { now, requestId: newId(ID_PREFIXES.request), workerId };
        const evaluation = claimDueEvaluation(ctx) ?? claimDueMessageWake(ctx);
        if (!evaluation) break;
        const evaluator =
          options.evaluateWake ??
          globalState.sproutWakeEvaluator ??
          (async () => {
            throw new Error("provider_unavailable");
          });
        const claimedGeneration = generation;
        const live = () => started && generation === claimedGeneration;
        const work = (
          evaluation.source === "message"
            ? evaluateMessageClaim(evaluation, evaluator, ctx, live, time.now)
            : evaluateClaim(evaluation, evaluator, ctx, live, time.now)
        )
          .then(() => {
            if (live()) bindPendingDeliveries(time.now());
          })
          .catch(report)
          .finally(() => {
            inflight.delete(work);
            rearm();
          });
        inflight.add(work);
      }
    } finally {
      busy = false;
      rearm();
    }
  }
  function changed() {
    if (!started) return;
    try {
      if (config.SPROUT_CONTINUATION_ENABLED) {
        scanChatSchedules(time.now());
        bindPendingDeliveries(time.now());
      }
    } catch (error) {
      report(error);
    } finally {
      rearm();
    }
  }
  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      if (config.SPROUT_CONTINUATION_ENABLED) recoverSchedules(time.now());
      unsubscribe = onScheduleChange(changed);
      if (config.SPROUT_CONTINUATION_ENABLED)
        drainContinuationAborts(time.now(), options.abort ?? (() => false));
      // 兜底：即使某个 signal 丢失，也要定期检查 due 的 message/Task 判定。
      heartbeat = time.setInterval?.(() => {
        void advance().catch(report);
      }, 15_000);
      void advance().catch(report);
    },
    stop() {
      started = false;
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) time.clearTimeout(timer);
      timer = undefined;
      if (heartbeat !== undefined) time.clearInterval?.(heartbeat);
      heartbeat = undefined;
    },
    advance,
    settled: () => Promise.all(inflight),
    snapshot: () => ({ started, timerArmed: timer !== undefined, inflight: inflight.size }),
  };
}
export type ContinuationScheduler = ReturnType<typeof createContinuationScheduler>;
