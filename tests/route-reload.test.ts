import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ROUTE_RELOAD_WINDOW_MS,
  createRouteReload,
  requestRouteReload,
} from "../src/lib/route-reload";

// Risk → evidence: 一次整链重取就是十几个请求；反应式来源落在不同宏任务里时 Router 自己不合并，
// 10 次 online 间隔 30ms 实测发出 170 个请求。这里用假时钟驱动真实的合并逻辑，
// 断言落在 reload 的调用次数、补跑的时机，以及 await 的结算点上。

const time = () => ({
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
});

function start(windowMs = ROUTE_RELOAD_WINDOW_MS) {
  const reload = vi.fn(async () => {});
  const control = createRouteReload({ reload, time: time(), windowMs });
  return { reload, control };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("整链重取的合并", () => {
  it("单次请求立刻重取，不额外延迟", async () => {
    const { reload, control } = start();
    void control.request();
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(ROUTE_RELOAD_WINDOW_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    control.stop();
  });

  it("窗口内间隔 30ms 的十次请求只重取两次", async () => {
    const { reload, control } = start();
    void control.request();
    for (let i = 0; i < 9; i++) {
      await tick(30);
      void control.request();
    }
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(ROUTE_RELOAD_WINDOW_MS);
    expect(reload).toHaveBeenCalledTimes(2);
    control.stop();
  });

  it("重取在途时到的请求只补一次，不叠加", async () => {
    let release: () => void = () => {};
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const control = createRouteReload({ reload, time: time() });
    void control.request();
    expect(reload).toHaveBeenCalledTimes(1);
    void control.request();
    void control.request();
    release();
    await tick(0);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(ROUTE_RELOAD_WINDOW_MS);
    expect(reload).toHaveBeenCalledTimes(2);
    control.stop();
  });

  it("三秒内每 100ms 一次的风暴每秒最多两次", async () => {
    const { reload, control } = start();
    for (let i = 0; i < 30; i++) {
      void control.request();
      await tick(100);
    }
    const calls = reload.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(4);
    expect(calls).toBeGreaterThanOrEqual(3);
    control.stop();
  });

  it("stop 之后不再重取，已排的补跑取消", async () => {
    const { reload, control } = start();
    void control.request();
    await tick(30);
    void control.request();
    control.stop();
    await tick(2000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("一次重取失败不会卡住后续请求", async () => {
    const reload = vi.fn(async () => {
      throw new Error("network");
    });
    const control = createRouteReload({ reload, time: time() });
    await expect(control.request()).resolves.toBeUndefined();
    await tick(ROUTE_RELOAD_WINDOW_MS);
    await control.request();
    expect(reload).toHaveBeenCalledTimes(2);
    control.stop();
  });

  it("await 等的是这一轮重取真正完成", async () => {
    let release: () => void = () => {};
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const control = createRouteReload({ reload, time: time() });
    let settled = false;
    const wait = control.request().then(() => {
      settled = true;
    });
    await tick(0);
    expect(settled).toBe(false);
    release();
    await wait;
    expect(settled).toBe(true);
    control.stop();
  });

  it("同一个 Router 共用一份窗口", async () => {
    const router = { invalidate: vi.fn(async () => {}) };
    const first = requestRouteReload(router);
    const second = requestRouteReload(router);
    await first;
    expect(router.invalidate).toHaveBeenCalledTimes(1);
    await tick(ROUTE_RELOAD_WINDOW_MS);
    await second;
    expect(router.invalidate).toHaveBeenCalledTimes(2);
  });
});
