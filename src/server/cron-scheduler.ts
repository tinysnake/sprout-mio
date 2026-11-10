import { rebaseCronCursors, tickCronRules } from "../domain/automation";

type CronClock = {
  now: () => Date;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
const clock: CronClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createCronScheduler(
  options: { clock?: CronClock; onError?: (error: unknown) => void } = {},
) {
  const time = options.clock ?? clock;
  const report = options.onError ?? ((error) => console.error("[cron-scheduler]", error));
  let started = false;
  let timer: unknown;
  let previous = 0;
  let generation = 0;
  function rearm() {
    if (!started) return;
    const current = generation;
    timer = time.setTimeout(() => {
      if (!started || current !== generation) return;
      timer = undefined;
      const now = time.now();
      const elapsed = now.getTime() - previous;
      previous = now.getTime();
      try {
        tickCronRules(now, elapsed < 0 || elapsed > 10_000);
      } catch (error) {
        report(error);
      } finally {
        rearm();
      }
    }, 1_000);
  }
  return {
    start() {
      if (started) return;
      const bootNow = time.now();
      rebaseCronCursors(bootNow);
      previous = bootNow.getTime();
      started = true;
      generation += 1;
      try {
        rearm();
      } catch (error) {
        started = false;
        throw error;
      }
    },
    stop() {
      started = false;
      generation += 1;
      if (timer !== undefined) time.clearTimeout(timer);
      timer = undefined;
    },
    snapshot: () => ({ started, timerArmed: timer !== undefined }),
  };
}
export type CronScheduler = ReturnType<typeof createCronScheduler>;
