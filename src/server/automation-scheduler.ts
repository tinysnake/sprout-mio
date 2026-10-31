import { randomUUID } from "node:crypto";
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
import { drainAutomationAborts } from "../domain/chat-automation";

export type SchedulerClock = {
  now: () => Date;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
const clock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const globalState = globalThis as typeof globalThis & { sproutWakeEvaluator?: EvaluateWake };
/** Integration wires judge's result-only adapter here. No fallback to another provider is allowed. */
export function installWakeEvaluator(evaluateWake: EvaluateWake) {
  globalState.sproutWakeEvaluator = evaluateWake;
}
export function createAutomationScheduler(
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
    started = false,
    busy = false,
    generation = 0,
    unsubscribe: (() => void) | undefined;
  const inflight = new Set<Promise<void>>();
  const report = options.onError ?? ((error) => console.error("[automation-scheduler]", error));
  function rearm() {
    if (!started) return;
    if (timer !== undefined) {
      time.clearTimeout(timer);
      timer = undefined;
    }
    // No assigned Task and no pending transport retry means no Task timer at all.
    const next = one<{ due: number | null }>(
      "SELECT min(due) AS due FROM (SELECT next_due_at AS due FROM chat_schedule WHERE next_due_at IS NOT NULL UNION ALL SELECT next_attempt_at AS due FROM continuation_delivery WHERE state='pending' AND next_attempt_at IS NOT NULL)",
    )?.due;
    if (next !== null && next !== undefined)
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
      scanChatSchedules(now);
      drainAutomationAborts(now, options.abort ?? (() => false));
      bindPendingDeliveries(now);
      // Claims are synchronous; provider requests run concurrently without holding the writer lock.
      for (let n = 0; n < 100; n++) {
        const ctx: SchedulerContext = { now, requestId: `req_${randomUUID()}`, workerId };
        const evaluation = claimDueEvaluation(ctx);
        if (!evaluation) break;
        const evaluator =
          options.evaluateWake ??
          globalState.sproutWakeEvaluator ??
          (async () => {
            throw new Error("provider_unavailable");
          });
        const claimedGeneration = generation;
        const live = () => started && generation === claimedGeneration;
        const work = evaluateClaim(evaluation, evaluator, ctx, live, time.now)
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
      scanChatSchedules(time.now());
      bindPendingDeliveries(time.now());
      rearm();
    } catch (error) {
      report(error);
    }
  }
  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      recoverSchedules(time.now());
      unsubscribe = onScheduleChange(changed);
      drainAutomationAborts(time.now(), options.abort ?? (() => false));
      void advance().catch(report);
    },
    stop() {
      started = false;
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) time.clearTimeout(timer);
      timer = undefined;
    },
    advance,
    settled: () => Promise.all([...inflight]),
    snapshot: () => ({ started, timerArmed: timer !== undefined, inflight: inflight.size }),
  };
}
export type AutomationScheduler = ReturnType<typeof createAutomationScheduler>;
