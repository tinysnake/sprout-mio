import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CHAT_LIVE_INTERVAL_MS,
  createChatLiveRefresh,
  isActiveRunState,
} from "../src/components/chat/use-chat-live";
import type { AgentRun, AgentRunResult, ChatRunState } from "../src/contracts/agent-run";
import type { ChatResult, Message } from "../src/contracts/chat";
import { latestActivityAt } from "../src/components/chat/chat-list";

// Risk → evidence: 活跃 run 期间的请求数与后台流量、隐藏页面、轮询重叠、
// 一次读失败把轮询打死、run 收尾后还在刷、以及「跑完还要不要重读整树」这件事。
// 假时钟驱动真实的 tick 逻辑，读函数是注入的，断言落在调用次数与并发上。

const messages = { ok: true, data: [] as Message[], requestId: "req_1" } as ChatResult<Message[]>;

function run(id: string, status: AgentRun["status"]): AgentRun {
  return { id, status } as AgentRun;
}

function state(...runs: AgentRun[]): AgentRunResult<ChatRunState> {
  const active = runs.filter((run) => run.status === "queued" || run.status === "running");
  return {
    ok: true,
    data: { enabled: true, active, latest: runs.at(-1) ?? null, inputs: [] },
    requestId: "req_1",
  } as AgentRunResult<ChatRunState>;
}

const failedRunState = {
  ok: false,
  error: { code: "internal", message: "boom" },
  requestId: "req_1",
} as unknown as AgentRunResult<ChatRunState>;

function environment(visible = true) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: visible ? ("visible" as const) : ("hidden" as const),
  });
  return { document };
}

const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("Chat 活跃 run 的定点刷新", () => {
  it("一个 tick 同时发起消息与 run 状态两个读，不等前一个回来", async () => {
    const started: string[] = [];
    const settle: (() => void)[] = [];
    stops.push(
      createChatLiveRefresh({
        reads: {
          messages: () => {
            started.push("messages");
            return new Promise((resolve) => settle.push(() => resolve(messages)));
          },
          runState: () => {
            started.push("runState");
            return new Promise((resolve) => settle.push(() => resolve(state(run("run_a", "running")))));
          },
        },
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    // 两个读都已在途：串行等待会让数组只有一个元素。
    expect(started).toEqual(["messages", "runState"]);
    settle.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
  });

  it("页面隐藏时不发请求，切回可见立刻补一次", async () => {
    const env = environment(false);
    const refresh = {
      messages: vi.fn().mockResolvedValue(messages),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
    };
    stops.push(
      createChatLiveRefresh({
        reads: refresh,
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        environment: env,
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 5);
    expect(refresh.messages).not.toHaveBeenCalled();
    env.document.visibilityState = "visible";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh.messages).toHaveBeenCalledTimes(1);
    expect(refresh.runState).toHaveBeenCalledTimes(1);
  });

  it("上一次读数还没回来就跳过这一轮，不叠请求", async () => {
    let pending: (() => void) | undefined;
    const reads = {
      messages: vi.fn().mockResolvedValue(messages),
      runState: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              pending = () => resolve(state(run("run_a", "running")));
            }),
        )
        .mockResolvedValue(state(run("run_a", "running"))),
    };
    stops.push(
      createChatLiveRefresh({
        reads,
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 3 + 200);
    expect(reads.runState).toHaveBeenCalledTimes(1);
    pending?.();
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS + 200);
    expect(reads.runState).toHaveBeenCalledTimes(2);
  });

  it("run 状态推进只回报一次重读，收尾后再不轮询", async () => {
    const runState = vi
      .fn()
      .mockResolvedValueOnce(state(run("run_a", "running")))
      .mockResolvedValueOnce(state(run("run_a", "completed")));
    const onFacts = vi.fn();
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads: { messages: vi.fn().mockResolvedValue(messages), runState },
        onFacts,
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
    expect(onFacts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 10);
    expect(runState).toHaveBeenCalledTimes(2);
  });

  it("首个 tick 就发现 run 已收尾时仍然回报一次重读", async () => {
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads: {
          messages: vi.fn().mockResolvedValue(messages),
          runState: vi.fn().mockResolvedValue(state(run("run_a", "completed"))),
        },
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 5);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
  });

  it("首个 tick 发现新 run 起跑时回报一次重读", async () => {
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads: {
          messages: vi.fn().mockResolvedValue(messages),
          runState: vi.fn().mockResolvedValue(state(run("run_a", "queued"))),
        },
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
  });

  it("loader 已知的空闲指纹不触发重读，也不继续轮询", async () => {
    const reads = {
      messages: vi.fn().mockResolvedValue(messages),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "completed"))),
    };
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads,
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "run_a:completed",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 5);
    expect(onRunChanged).not.toHaveBeenCalled();
    expect(reads.runState).toHaveBeenCalledTimes(1);
  });

  it("一次读失败不回报、不停止，下一轮继续读", async () => {
    const reads = {
      messages: vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(messages),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
    };
    const onFacts = vi.fn();
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads,
        onFacts,
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onFacts).not.toHaveBeenCalled();
    expect(onRunChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onFacts).toHaveBeenCalledTimes(1);
    expect(reads.messages).toHaveBeenCalledTimes(2);
  });

  it("停止后不再发请求，也不再报重读", async () => {
    const reads = {
      messages: vi.fn().mockResolvedValue(messages),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"), run("run_b", "queued"))),
    };
    const onRunChanged = vi.fn();
    const stop = createChatLiveRefresh({
      reads,
      onFacts: vi.fn(),
      onRunChanged,
      seedSignature: "run_a:running,run_b:queued",
      environment: environment(),
    });
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(reads.runState).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 5);
    expect(reads.runState).toHaveBeenCalledTimes(1);
    expect(onRunChanged).not.toHaveBeenCalled();
  });

  it("run 状态读不到时不改门禁，继续轮询", async () => {
    const reads = {
      messages: vi.fn().mockResolvedValue(messages),
      runState: vi.fn().mockResolvedValue(failedRunState),
    };
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        reads,
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 3);
    expect(reads.runState).toHaveBeenCalledTimes(3);
    expect(onRunChanged).not.toHaveBeenCalled();
  });

  it("门禁只认 run 状态：排队与运行中算活动，其余都不算", () => {
    expect(isActiveRunState(state(run("run_a", "queued")))).toBe(true);
    expect(isActiveRunState(state(run("run_a", "running")))).toBe(true);
    expect(isActiveRunState(state(run("run_a", "aborted")))).toBe(false);
    expect(isActiveRunState(state())).toBe(false);
    expect(isActiveRunState(failedRunState)).toBe(false);
  });

  it("列表时间取较新的一条：活跃 run 比 chat.updatedAt 新时不再滞后", () => {
    const updated = "2026-01-02T03:04:05.000Z";
    expect(latestActivityAt(updated, "2026-01-02T03:05:00.000Z")).toBe("2026-01-02T03:05:00.000Z");
    expect(latestActivityAt(updated, "2026-01-02T03:00:00.000Z")).toBe(updated);
    expect(latestActivityAt(updated)).toBe(updated);
    // 两种 ISO 写法混用时按时刻比，不按字符串比。
    expect(latestActivityAt("2026-01-02T11:00:00+08:00", "2026-01-02T03:30:00.000Z")).toBe(
      "2026-01-02T03:30:00.000Z",
    );
  });
});
