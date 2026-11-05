import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CHAT_IDLE_INTERVAL_MS,
  CHAT_LIVE_INTERVAL_MS,
  createChatLiveRefresh,
  isActiveRunState,
} from "../src/components/chat/use-chat-live";
import type {
  ChatLiveFacts,
  ChatLiveRefresh,
  ChatLiveSeed,
} from "../src/components/chat/use-chat-live";
import type { AgentRun, AgentRunResult, ChatRunState } from "../src/contracts/agent-run";
import { compareMessageCursor, laterMessageCursor } from "../src/contracts/chat";
import type { ChatResult, Message, MessageWindow } from "../src/contracts/chat";
import type { AppResult } from "../src/contracts/result";
import type { ChatContinuationData } from "../src/domain/chat-continuation";
import { latestActivityAt } from "../src/components/chat/chat-list";

// Risk → evidence: 活跃 run 期间的请求数与后台流量、隐藏页面、轮询重叠、
// 一次读失败把轮询打死、run 收尾后还在刷、以及「跑完还要不要重读整树」这件事。
// 假时钟驱动真实的 tick 逻辑，读函数是注入的，断言落在调用次数与并发上。

const emptySeed: ChatLiveSeed = { messages: [], cursor: null };

const emptyWindow = {
  ok: true,
  data: {
    messages: [] as Message[],
    tailCursor: null,
    olderCursor: null,
    hasOlder: false,
    hasNewer: false,
  },
  requestId: "req_1",
} as ChatResult<MessageWindow>;

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

/** 判定读也是 tick 的一部分：判定不改消息也不改 run，缺这块页面就永远停在旧状态。 */
const continuationView = {
  projectId: "prj_00000001",
  chatId: "cnv_00000001",
  mode: "enabled",
  epoch: 1,
  revision: 1,
  owner: { kind: "agent", id: "agp_00000001" },
  changedBy: null,
  changedAt: null,
  reason: null,
  assignedTaskIds: [],
  nextDueAt: null,
  activeRunIds: [],
  remindedHuman: false,
  latestEvaluation: null,
  recentRounds: [],
  deliveries: [],
  attention: null,
} as ChatContinuationData["view"];

const continuationFacts = {
  ok: true,
  data: {
    view: continuationView,
    allowedActions: [],
    denials: {},
  },
  requestId: "req_1",
} as unknown as AppResult<ChatContinuationData>;
const continuationRead = async () => continuationFacts;

/** 只换判定状态，其余字段不动：用来验证「判定变了要不要重读整树」。 */
function continuationWith(state: "claimed" | "attention"): AppResult<ChatContinuationData> {
  const failed = state === "attention";
  return {
    ok: true,
    data: {
      view: {
        ...continuationView,
        latestEvaluation: {
          evaluationId: "evaluation_0001",
          source: "task_periodic",
          state,
          round: 1,
          attempt: 1,
          claimedAt: "2026-01-02T03:04:05.000Z",
          finishedAt: failed ? "2026-01-02T03:09:05.000Z" : null,
          evaluatedAt: failed ? "2026-01-02T03:09:05.000Z" : null,
          nextAttemptAt: null,
          result: null,
          errorCode: failed ? "provider_timeout" : null,
          usage: null,
        },
      },
      allowedActions: [],
      denials: {},
    },
    requestId: "req_1",
  } as unknown as AppResult<ChatContinuationData>;
}

function environment(visible = true) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: visible ? ("visible" as const) : ("hidden" as const),
  });
  return { document };
}

const stops: ChatLiveRefresh[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach((refresh) => refresh.stop());
  vi.useRealTimers();
});

describe("Chat 活跃 run 的定点刷新", () => {
  it("一个 tick 同时发起消息、run 状态与判定三个读，不等前一个回来", async () => {
    const started: string[] = [];
    const settle: (() => void)[] = [];
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          messages: () => {
            started.push("messages");
            return new Promise((resolve) => settle.push(() => resolve(emptyWindow)));
          },
          runState: () => {
            started.push("runState");
            return new Promise((resolve) =>
              settle.push(() => resolve(state(run("run_a", "running")))),
            );
          },
          continuation: () => {
            started.push("continuation");
            return new Promise((resolve) => settle.push(() => resolve(continuationFacts)));
          },
        },
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    // 三个读都已在途：串行等待会让数组只剩一个元素。
    expect(started).toEqual(["messages", "runState", "continuation"]);
    settle.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(3);
  });

  it("判定状态每 tick 都回传页面，不必等 run 变化触发整树重读", async () => {
    const facts: ChatLiveFacts[] = [];
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          messages: async () => emptyWindow,
          runState: async () => state(run("run_a", "running")),
          continuation: async () => continuationFacts,
        },
        onFacts: (next) => facts.push(next),
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    // 判定从 pending 走到 claimed 时 run 没有任何变化；页面仍拿到新的 continuation。
    expect(facts.at(-1)?.continuation).toBe(continuationFacts);
    expect(onRunChanged).not.toHaveBeenCalled();
  });

  it("判定从正在检查落到失败时回报一次整树重读", async () => {
    const readings = [continuationWith("claimed"), continuationWith("attention")];
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          continuation: () => Promise.resolve(readings.shift() ?? continuationWith("attention")),
          messages: vi.fn().mockResolvedValue(emptyWindow),
          runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
        },
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    // 首个 tick 只立基准：判定已经处于 claimed，也不为对齐它重读整树。
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).not.toHaveBeenCalled();
    // 判定落到失败：run 没动、消息没动，只由 loader 读来的 Info Hub 读视图也必须跟上。
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
    // 同一份判定再读到时不重复重读，不制造来回 invalidate。
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
  });

  it("页面隐藏时不发请求，切回可见立刻补一次", async () => {
    const env = environment(false);
    const refresh = {
      continuation: vi.fn().mockResolvedValue(continuationFacts),
      messages: vi.fn().mockResolvedValue(emptyWindow),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
    };
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
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
      continuation: continuationRead,
      messages: vi.fn().mockResolvedValue(emptyWindow),
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
        seed: emptySeed,
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
        seed: emptySeed,
        reads: {
          continuation: continuationRead,
          messages: vi.fn().mockResolvedValue(emptyWindow),
          runState,
        },
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

  it("空闲时按较慢节奏继续轮询，能发现后来启动的 run", async () => {
    const runState = vi
      .fn()
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state(run("run_b", "running")));
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          continuation: continuationRead,
          messages: vi.fn().mockResolvedValue(emptyWindow),
          runState,
        },
        onFacts: vi.fn(),
        onRunChanged,
        seedSignature: "",
        stopWhenIdle: false,
        intervalMs: CHAT_IDLE_INTERVAL_MS,
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_INTERVAL_MS);
    expect(runState).toHaveBeenCalledTimes(1);
    expect(onRunChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHAT_IDLE_INTERVAL_MS);
    expect(runState).toHaveBeenCalledTimes(2);
    expect(onRunChanged).toHaveBeenCalledTimes(1);
  });

  it("新消息到达时回报一次重读，让 Info Hub 消息计数同步", async () => {
    const onMessagesChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          continuation: continuationRead,
          messages: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              messages: [{ id: "msg_00000001" } as Message],
              tailCursor: null,
              olderCursor: null,
              hasOlder: false,
              hasNewer: false,
            },
            requestId: "req_1",
          } as ChatResult<MessageWindow>),
          runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
        },
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        onMessagesChanged,
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onMessagesChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(onMessagesChanged).toHaveBeenCalledTimes(1);
  });

  it("首个 tick 就发现 run 已收尾时仍然回报一次重读", async () => {
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
        reads: {
          continuation: continuationRead,
          messages: vi.fn().mockResolvedValue(emptyWindow),
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
        seed: emptySeed,
        reads: {
          continuation: continuationRead,
          messages: vi.fn().mockResolvedValue(emptyWindow),
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
      continuation: continuationRead,
      messages: vi.fn().mockResolvedValue(emptyWindow),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "completed"))),
    };
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
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
      continuation: continuationRead,
      messages: vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(emptyWindow),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"))),
    };
    const onFacts = vi.fn();
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
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
      continuation: continuationRead,
      messages: vi.fn().mockResolvedValue(emptyWindow),
      runState: vi.fn().mockResolvedValue(state(run("run_a", "running"), run("run_b", "queued"))),
    };
    const onRunChanged = vi.fn();
    const refresh = createChatLiveRefresh({
      seed: emptySeed,
      reads,
      onFacts: vi.fn(),
      onRunChanged,
      seedSignature: "run_a:running,run_b:queued",
      environment: environment(),
    });
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(reads.runState).toHaveBeenCalledTimes(1);
    refresh.stop();
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 5);
    expect(reads.runState).toHaveBeenCalledTimes(1);
    expect(onRunChanged).not.toHaveBeenCalled();
  });

  it("run 状态读不到时不改门禁，继续轮询", async () => {
    const reads = {
      continuation: continuationRead,
      messages: vi.fn().mockResolvedValue(emptyWindow),
      runState: vi.fn().mockResolvedValue(failedRunState),
    };
    const onRunChanged = vi.fn();
    stops.push(
      createChatLiveRefresh({
        seed: emptySeed,
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

// Risk → evidence: 消息增量读的游标。createdAt 只有秒级精度，同一秒的多条消息靠 rowid 分先后；
// loader 与 tick 之间有竞态，重叠的消息必须去重而不是重复追加。
describe("消息增量读的游标", () => {
  function message(id: string): Message {
    return {
      id,
      chatId: "cnv_00000001",
      senderKind: "human",
      senderId: "user_1",
      body: id,
      createdAt: "2026-01-02T03:04:05.000Z",
      mentions: [],
    };
  }

  function reply(entries: Message[], cursor: string | null): ChatResult<MessageWindow> {
    return {
      ok: true,
      data: {
        messages: entries,
        tailCursor: cursor,
        olderCursor: null,
        hasOlder: false,
        hasNewer: false,
      },
      requestId: "req_1",
    };
  }

  const ids = (result: ChatResult<Message[]> | undefined) =>
    result?.ok ? result.data.map((entry) => entry.id) : null;

  it("首个 tick 用 loader 的尾巴，之后用上一 tick 返回的游标", async () => {
    const asked: (string | null)[] = [];
    const replies = [reply([message("msg_00000002")], "2026:5"), reply([], "2026:5")];
    stops.push(
      createChatLiveRefresh({
        seed: { messages: [message("msg_00000001")], cursor: "2026:4" },
        reads: {
          continuation: continuationRead,
          messages: (after) => {
            asked.push(after);
            return Promise.resolve(replies.shift() ?? reply([], "2026:5"));
          },
          runState: () => Promise.resolve(state(run("run_a", "running"))),
        },
        onFacts: vi.fn(),
        onRunChanged: vi.fn(),
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS * 3);
    expect(asked).toEqual(["2026:4", "2026:5", "2026:5"]);
  });

  it("增量按 id 去重后追加到 loader 那批后面", async () => {
    const facts: ChatLiveFacts[] = [];
    stops.push(
      createChatLiveRefresh({
        seed: { messages: [message("msg_00000001"), message("msg_00000002")], cursor: "2026:2" },
        reads: {
          continuation: continuationRead,
          // loader 与 tick 的竞态：第二条两边都有，只追加后面那条。
          messages: () =>
            Promise.resolve(reply([message("msg_00000002"), message("msg_00000003")], "2026:3")),
          runState: () => Promise.resolve(state(run("run_a", "running"))),
        },
        onFacts: (next) => facts.push(next),
        onRunChanged: vi.fn(),
        seedSignature: "run_a:running",
        environment: environment(),
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(ids(facts.at(-1)?.messages)).toEqual(["msg_00000001", "msg_00000002", "msg_00000003"]);
  });

  it("loader 换了：overlay 回到 loader 那批，在途的增量只补差、游标不回退", async () => {
    const facts: ChatLiveFacts[] = [];
    const asked: (string | null)[] = [];
    let settleFirst: ((value: ChatResult<MessageWindow>) => void) | undefined;
    const refresh = createChatLiveRefresh({
      seed: { messages: [message("msg_00000001")], cursor: "2026:1" },
      reads: {
        continuation: continuationRead,
        messages: (after) => {
          asked.push(after);
          if (settleFirst) return Promise.resolve(reply([message("msg_00000005")], "2026:8"));
          return new Promise((resolve) => {
            settleFirst = resolve;
          });
        },
        runState: () => Promise.resolve(state(run("run_a", "running"))),
      },
      onFacts: (next) => facts.push(next),
      onRunChanged: vi.fn(),
      seedSignature: "run_a:running",
      environment: environment(),
    });
    stops.push(refresh);
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(asked).toEqual(["2026:1"]);

    // loader invalidate 之后：overlay 换成新 loader 那批，游标回到它的尾巴。
    refresh.reseed({
      messages: [message("msg_00000002"), message("msg_00000003")],
      cursor: "2026:6",
    });
    // 在途那批是按旧游标读的：一条 loader 已有，一条 loader 还没读到。
    settleFirst?.(reply([message("msg_00000003"), message("msg_00000004")], "2026:4"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(facts.at(-1)?.messages)).toEqual(["msg_00000002", "msg_00000003", "msg_00000004"]);

    // 下一 tick 从 loader 的尾巴继续：在途结果里的 "2026:4" 更早，不能把游标拉回去。
    await vi.advanceTimersByTimeAsync(CHAT_LIVE_INTERVAL_MS);
    expect(asked).toEqual(["2026:1", "2026:6"]);
    expect(ids(facts.at(-1)?.messages)).toEqual([
      "msg_00000002",
      "msg_00000003",
      "msg_00000004",
      "msg_00000005",
    ]);
  });

  it("游标按 (createdAt, rowid) 两个数值比较，取较后者不回退", () => {
    expect(compareMessageCursor("10:2", "9:11")).toBeGreaterThan(0);
    expect(compareMessageCursor("10:2", "10:11")).toBeLessThan(0);
    expect(compareMessageCursor("10:2", "10:2")).toBe(0);
    expect(laterMessageCursor("10:2", "9:11")).toBe("10:2");
    expect(laterMessageCursor("9:11", "10:2")).toBe("10:2");
    expect(laterMessageCursor(null, "10:2")).toBe("10:2");
    expect(laterMessageCursor("10:2", null)).toBe("10:2");
    expect(laterMessageCursor(null, null)).toBeNull();
  });
});
