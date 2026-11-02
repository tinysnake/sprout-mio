import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { requestRouteReload } from "../../lib/route-reload";

const REFRESH_MS = 5000;

type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "setTimeout" | "clearTimeout">;
};

/**
 * 机器页整页重取的调度。
 *
 * 没有 revision 来源时保持原来的五秒定时重取；给了 revision 就只在 revision
 * 真的变化（含首次 `null → rN`）或重新可见时重取一次，不再按时钟空跑。
 */
export function createMachineRefreshSchedule({
  refresh,
  intervalMs,
  environment,
}: {
  refresh: () => Promise<unknown> | void;
  intervalMs: number;
  environment: Environment;
}) {
  const { document, window } = environment;
  let revision: string | null | undefined;
  let started = false;
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: number | undefined;
  const clearTimer = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const visible = () => document.visibilityState === "visible";

  function arm() {
    clearTimer();
    if (stopped || running || !visible()) return;
    timer = window.setTimeout(() => void run(), intervalMs);
  }

  async function run() {
    clearTimer();
    if (stopped || !visible()) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch {
      // Retry quietly on the next cycle; manual refresh stays available.
    } finally {
      running = false;
      if (!stopped) {
        if (pending) {
          pending = false;
          void run();
        } else if (revision === undefined) arm();
      }
    }
  }

  // 定时分支与原来一致：重新可见只重新排一个周期，不立刻补一次。
  // revision 分支没有时钟可等，隐藏期间的变化必须靠重新可见补读。
  function onVisibilityChange() {
    if (!visible()) {
      if (revision === undefined) clearTimer();
      return;
    }
    if (revision === undefined) arm();
    else void run();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    /** `undefined` 表示没有 revision 来源（退回五秒定时），null 表示还没读到。 */
    sync(next: string | null | undefined) {
      if (!started) {
        started = true;
        revision = next;
        if (next === undefined) arm();
        return;
      }
      if (next === revision) return;
      const wasInterval = revision === undefined;
      revision = next;
      if (next === undefined) arm();
      else if (wasInterval) {
        // 从定时分支切过来：不必立即重取，等 revision 真的变化或重新可见。
        clearTimer();
      } else void run();
    },
    refresh: () => void run(),
    stop() {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

/**
 * 返回 router 供手动刷新继续使用。传 `revision` 的页面不再起五秒定时器；
 * 不传的页面（还没有 revision 来源）保持原有行为。
 */
export function useMachineRefresh({ revision }: { revision?: string | null } = {}) {
  const router = useRouter();
  const schedule = useRef<ReturnType<typeof createMachineRefreshSchedule> | null>(null);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;

  useEffect(() => {
    const reads = createMachineRefreshSchedule({
      refresh: () => requestRouteReload(router),
      intervalMs: REFRESH_MS,
      environment: { document, window },
    });
    schedule.current = reads;
    reads.sync(latestRevision.current);
    return () => {
      reads.stop();
      schedule.current = null;
    };
  }, [router]);

  useEffect(() => {
    schedule.current?.sync(revision);
  }, [revision]);

  return router;
}
