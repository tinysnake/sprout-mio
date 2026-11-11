import { describe, expect, it } from "vite-plus/test";
import { REMOTE_OUTCOMES, executionViewSchema } from "../src/contracts/remote";
import {
  clampExecutionWaitMs,
  EXECUTION_WAIT_DEFAULT_MS,
  EXECUTION_WAIT_MAX_MS,
  EXECUTION_WAIT_POLL_MS,
} from "../src/contracts/tool-wait";
import { waitForExecution } from "../src/domain/execution-wait";
import { executionWaitView } from "./fixtures/execution-wait-view";

function clock() {
  let elapsed = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(elapsed),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      elapsed += ms;
    },
  };
}

describe("阻塞等待 execution", () => {
  it.each(REMOTE_OUTCOMES)("已是终态 %s 时只读一次、不睡眠", async (state) => {
    const time = clock();
    let reads = 0;
    const view = executionWaitView(state);
    expect(executionViewSchema.safeParse(view).success).toBe(true);
    expect(
      await waitForExecution({
        deps: {
          ...time,
          readExecution: () => {
            reads += 1;
            return view;
          },
        },
      }),
    ).toEqual({ ok: true, view });
    expect(reads).toBe(1);
    expect(time.sleeps).toEqual([]);
  });

  it("持续轮询非终态，直到读到终态", async () => {
    const time = clock();
    const views = ["queued", "dispatched", "running", "draining", "succeeded"].map((state) =>
      executionWaitView(state as Parameters<typeof executionWaitView>[0]),
    );
    let reads = 0;
    const outcome = await waitForExecution({
      deps: { ...time, readExecution: async () => views[reads++]! },
    });
    expect(outcome).toEqual({ ok: true, view: views.at(-1) });
    expect(reads).toBe(5);
    expect(time.sleeps).toEqual(Array(4).fill(EXECUTION_WAIT_POLL_MS));
  });

  it("到点返回最后一次视图，末次只睡剩余时长", async () => {
    const time = clock();
    let reads = 0;
    const running = executionWaitView();
    const draining = executionWaitView("draining");
    const outcome = await waitForExecution({
      requestedMs: 2_500,
      deps: { ...time, readExecution: () => (++reads < 4 ? running : draining) },
    });
    expect(outcome).toEqual({ ok: false, reason: "timed_out", view: draining });
    expect(time.sleeps).toEqual([1_000, 1_000, 500]);
    expect(reads).toBe(4);
  });

  it.each([
    [undefined, EXECUTION_WAIT_DEFAULT_MS],
    [Infinity, EXECUTION_WAIT_DEFAULT_MS],
    [NaN, EXECUTION_WAIT_DEFAULT_MS],
    [EXECUTION_WAIT_MAX_MS + 1, EXECUTION_WAIT_MAX_MS],
    [0, EXECUTION_WAIT_POLL_MS],
  ])("等待预算 %s 钳到 %s", async (requestedMs, expectedMs) => {
    expect(clampExecutionWaitMs(requestedMs)).toBe(expectedMs);
    const time = clock();
    const view = executionWaitView();
    expect(
      await waitForExecution({
        requestedMs,
        pollMs: EXECUTION_WAIT_MAX_MS,
        deps: { ...time, readExecution: () => view },
      }),
    ).toEqual({ ok: false, reason: "timed_out", view });
    expect(time.sleeps).toEqual([expectedMs]);
  });

  it("读取错误立即向上传播", async () => {
    const time = clock();
    const error = new Error("execution missing");
    await expect(
      waitForExecution({
        deps: {
          ...time,
          readExecution: async () => {
            throw error;
          },
        },
      }),
    ).rejects.toBe(error);
    expect(time.sleeps).toEqual([]);
  });
});
