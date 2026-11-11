import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SLEEP_MAX_MS } from "../src/contracts/tool-wait";
import { registerSleepTool } from "../src/extension/time-tools";
import type { SproutExtensionAPI } from "../src/extension/types";

function sleepTool() {
  const registered: Parameters<SproutExtensionAPI["registerTool"]>[0][] = [];
  registerSleepTool({
    registerTool: (tool) => {
      registered.push(tool);
    },
  });
  return registered[0]!;
}

afterEach(() => vi.useRealTimers());

describe("宿主 sleep", () => {
  it("按毫秒等待并返回当前 ISO 时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
    let finished = false;
    const pending = sleepTool()
      .execute("probe", { ms: 1_250 })
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      isError: false,
      details: {
        outcome: "slept",
        sleptMs: 1_250,
        requestedMs: 1_250,
        now: "2026-11-11T00:00:01.250Z",
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超出上限只睡 10 分钟，同时回报原请求时长", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const pending = sleepTool().execute("probe", { ms: SLEEP_MAX_MS + 1 });
    await vi.runAllTimersAsync();
    expect(Date.now() - startedAt).toBe(SLEEP_MAX_MS);
    expect(await pending).toMatchObject({
      details: { outcome: "slept", sleptMs: SLEEP_MAX_MS, requestedMs: SLEEP_MAX_MS + 1 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ ms: 0 }, { ms: -1 }, {}, { ms: Infinity }, { ms: "1" }, { ms: 1, extra: true }])(
    "拒绝无效参数 %j",
    async (input) => {
      expect(await sleepTool().execute("probe", input)).toMatchObject({
        isError: true,
        details: { outcome: "invalid_input" },
      });
    },
  );

  it.each([false, true])("取消等待立即返回且清理计时器（预先取消=%s）", async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const pending = sleepTool().execute("probe", { ms: SLEEP_MAX_MS }, controller.signal);
    if (!alreadyAborted) controller.abort();
    expect(await pending).toMatchObject({ isError: false, details: { outcome: "cancelled" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
