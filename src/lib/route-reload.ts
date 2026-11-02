/**
 * 反应式整链重取的合并。
 *
 * `router.invalidate()` 会重跑当前匹配链的 beforeLoad 与全部 loader，一次就是十几个请求。
 * 网络抖动、revision 变化、run 状态翻转这些反应式来源各自触发一次，落在不同宏任务里时
 * Router 自己不合并：本机 10 次 `online` 间隔 30ms 实测发出 170 个请求，同 tick 的 10 次只发 17 个。
 *
 * 策略是每秒最多两次整链重取。第一次立刻执行，不做延迟，单次刷新仍然是即时的；窗口内到过
 * 的请求合并成一次补跑，补的那次也占一个新窗口。实测 10 次间隔 100ms 的 online 从 170 个请求
 * 降到 34 个，间隔 30ms 的同样收敛。
 */
export const ROUTE_RELOAD_WINDOW_MS = 1_000;

export type RouteReloadTime = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type RouteReload = {
  /** 参与一次重取，重取完成后 resolve。 */
  request: () => Promise<void>;
  stop: () => void;
};

export function createRouteReload({
  reload,
  time,
  windowMs = ROUTE_RELOAD_WINDOW_MS,
}: {
  reload: () => Promise<unknown> | void;
  time: RouteReloadTime;
  windowMs?: number;
}): RouteReload {
  let stopped = false;
  let running = false;
  let dirty = false;
  let timer: unknown;
  let windowStart = Number.NEGATIVE_INFINITY;
  // 本轮重取要结算的调用方。重取期间到的请求进下一轮，不提前 resolve。
  let waiters: Array<() => void> = [];

  function settle(waiting: Array<() => void>) {
    for (const resolve of waiting) resolve();
  }

  function clearTimer() {
    if (timer === undefined) return;
    time.clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delayMs: number) {
    clearTimer();
    timer = time.setTimeout(
      () => {
        timer = undefined;
        void run();
      },
      Math.max(0, delayMs),
    );
  }

  async function run() {
    if (stopped || running) return;
    clearTimer();
    running = true;
    windowStart = time.now();
    const batch = waiters;
    waiters = [];
    try {
      await reload();
    } catch {
      // 反应式重取失败按下一轮再试，不把错误抛回事件处理器。
    } finally {
      running = false;
      settle(batch);
      if (!stopped && dirty) {
        dirty = false;
        schedule(windowStart + windowMs - time.now());
      }
    }
  }

  return {
    request() {
      if (stopped) return Promise.resolve();
      const joined = new Promise<void>((resolve) => waiters.push(resolve));
      const wait = windowStart + windowMs - time.now();
      if (running || wait > 0) {
        dirty = true;
        if (!running) schedule(wait);
        return joined;
      }
      void run();
      return joined;
    },
    stop() {
      stopped = true;
      dirty = false;
      clearTimer();
      const waiting = waiters;
      waiters = [];
      settle(waiting);
    },
  };
}

/**
 * 同一 Router 共用一份窗口：页面里每个反应式来源都从这里取，不各自起计时器。
 * 键是 router 实例本身，卸载不需要清理。
 */
const reloads = new WeakMap<object, RouteReload>();

export type RouteReloadTarget = { invalidate: () => Promise<unknown> | void };

const defaultTime: RouteReloadTime = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

export function requestRouteReload(router: RouteReloadTarget): Promise<void> {
  let reload = reloads.get(router);
  if (!reload) {
    reload = createRouteReload({ reload: () => router.invalidate(), time: defaultTime });
    reloads.set(router, reload);
  }
  return reload.request();
}
