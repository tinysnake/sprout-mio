import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createInfoHubPolling,
  InfoHubAccessError,
} from "../src/components/info-hub/use-info-hub-polling";
import { createMachineActivityPolling } from "../src/components/machine/use-machine-activity";
import { createMachineRefreshSchedule } from "../src/components/machine/use-machine-refresh";
import { createRelationReads } from "../src/components/machine/use-machine-relations";
import type { InfoHubRefreshInput } from "../src/contracts/info-hub-query";

// Risk → evidence: background traffic / stale resume / overlap / retry storms /
// disconnect recovery / disposed context writes. Fake clocks drive actual requests.
const projectId = "prj_11111111";
const input: InfoHubRefreshInput = {
  projectId,
  query: { view: "project", section: "agents", limit: 25, cursor: "old-page" },
  knownRevision: "old",
};
const changed = {
  kind: "changed",
  view: {
    projectId,
    view: "project",
    section: "agents",
    data: [],
    page: { total: 0, nextCursor: null },
    revision: "r1",
    asOf: "2026-06-18T02:28:00.000Z",
  },
};
function environment(visible = true, online = true) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: visible ? ("visible" as const) : ("hidden" as const),
  });
  const window = new EventTarget();
  const navigator = { onLine: online };
  return { document, window, navigator };
}
const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});
function start(
  env = environment(),
  refresh = vi.fn().mockResolvedValue(changed),
  onResult = vi.fn(),
  random = () => 0.5,
) {
  stops.push(createInfoHubPolling({ input, environment: env, refresh, onResult, random }));
  return { refresh, onResult, env };
}

describe("Human Info Hub polling", () => {
  it("sends zero requests while hidden, then immediately takes one full view", async () => {
    const { refresh, env } = start(environment(false));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled();
    env.document.visibilityState = "visible";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toEqual({
      projectId,
      query: { view: "project", section: "agents", limit: 25 },
    });
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uses unchanged revisions, but visibility restoration discards them", async () => {
    const { refresh, onResult, env } = start();
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockResolvedValue({
      kind: "unchanged",
      projectId,
      revision: "r1",
      asOf: changed.view.asOf,
      query: input.query,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refresh.mock.calls[1]![0].knownRevision).toBe("r1");
    expect(onResult.mock.calls[1]![0].kind).toBe("unchanged");
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent(new Event("visibilitychange"));
    env.document.visibilityState = "visible";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh.mock.calls[2]![0]).not.toHaveProperty("knownRevision");
    expect(refresh.mock.calls[2]![0].query).not.toHaveProperty("cursor");
  });

  it("holds one request in flight and coalesces resume events into one full refresh", async () => {
    let settle!: (value: unknown) => void;
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue(changed);
    const { env } = start(environment(), refresh);
    await vi.advanceTimersByTimeAsync(8_000);
    env.window.dispatchEvent(new Event("online"));
    env.window.dispatchEvent(new Event("online"));
    expect(refresh).toHaveBeenCalledTimes(1);
    settle(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1]![0]).not.toHaveProperty("knownRevision");
  });

  it("同一秒内重复的恢复事件只做一次全量刷新", async () => {
    const { refresh, env } = start();
    await vi.advanceTimersByTimeAsync(0);
    const base = refresh.mock.calls.length;
    for (let index = 0; index < 10; index++) {
      env.window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(refresh).toHaveBeenCalledTimes(base + 1);
    expect(refresh.mock.calls.at(-1)![0]).not.toHaveProperty("knownRevision");
  });

  it.each(
    (["hidden", "offline"] as const).flatMap((pause) =>
      [false, true].flatMap((connected) =>
        [false, true].map((held) => ({ pause, connected, held })),
      ),
    ),
  )(
    "keeps the next poll after $pause resume (SSE=$connected, in-flight=$held)",
    async ({ pause, connected, held }) => {
      const env = environment();
      const refresh = vi.fn().mockResolvedValue(changed);
      stops.push(
        createInfoHubPolling({
          input,
          environment: env,
          refresh,
          onResult: vi.fn(),
          changes: { connected: () => connected, subscribe: () => () => {} },
          random: () => 0.5,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      let settle!: (value: unknown) => void;
      if (held) {
        refresh.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settle = resolve;
            }),
        );
      }
      env.window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(100);
      expect(refresh.mock.calls[1]![0]).not.toHaveProperty("knownRevision");
      expect(refresh.mock.calls[1]![0].query).not.toHaveProperty("cursor");
      if (pause === "hidden") {
        env.document.visibilityState = "hidden";
        env.document.dispatchEvent(new Event("visibilitychange"));
        env.document.visibilityState = "visible";
        env.document.dispatchEvent(new Event("visibilitychange"));
      } else {
        env.navigator.onLine = false;
        env.window.dispatchEvent(new Event("offline"));
        env.navigator.onLine = true;
        env.window.dispatchEvent(new Event("online"));
      }
      expect(refresh).toHaveBeenCalledTimes(2);
      for (const event of ["online", "visibilitychange"]) {
        await vi.advanceTimersByTimeAsync(100);
        (event === "online" ? env.window : env.document).dispatchEvent(new Event(event));
        expect(refresh).toHaveBeenCalledTimes(2);
      }
      if (held) {
        settle(changed);
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledTimes(2);
      }
      const interval = connected ? 30_000 : 3_000;
      await vi.advanceTimersByTimeAsync(interval - (held ? 0 : 200) - 1);
      expect(refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(refresh.mock.calls.at(-1)![0].knownRevision).toBe("r1");
      expect(refresh.mock.calls.at(-1)![0].query).not.toHaveProperty("cursor");
    },
  );

  it("does not restart terminal polling on a deduplicated resume", async () => {
    const { refresh, env } = start();
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockRejectedValueOnce(new InfoHubAccessError("forbidden"));
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent(new Event("visibilitychange"));
    env.document.visibilityState = "visible";
    env.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("窗口过后再次恢复仍然全量刷新", async () => {
    const { refresh, env } = start();
    await vi.advanceTimersByTimeAsync(0);
    const base = refresh.mock.calls.length;
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(base + 1);
    await vi.advanceTimersByTimeAsync(1_200);
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(base + 2);
  });

  it("被窗口挡掉的恢复不会把轮询停摆", async () => {
    const { refresh, env } = start();
    await vi.advanceTimersByTimeAsync(0);
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    const base = refresh.mock.calls.length;
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(base);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refresh).toHaveBeenCalledTimes(base + 1);
  });

  it("backs off 3000 → 6000 → 12000 → 24000 → 30000 and resets after success", async () => {
    const times: number[] = [];
    let fail = true;
    const refresh = vi.fn().mockImplementation(async () => {
      times.push(Date.now());
      if (fail) throw new Error("offline service");
      return changed;
    });
    start(environment(), refresh);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [3000, 6000, 12000, 24000, 30000]) {
      const count = refresh.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(refresh).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(count + 1);
    }
    expect(times.slice(1).map((time, index) => time - times[index]!)).toEqual([
      3000, 6000, 12000, 24000, 30000,
    ]);
    fail = false;
    await vi.advanceTimersByTimeAsync(30000);
    const count = refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(count + 1);
  });

  it("pauses offline and immediately refreshes fully after reconnecting", async () => {
    const { env, refresh } = start(environment(true, false));
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
    env.navigator.onLine = true;
    env.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).not.toHaveProperty("knownRevision");
  });

  it("waits out a slow origin instead of aborting and retrying", async () => {
    let settle!: (value: unknown) => void;
    const refresh = vi.fn().mockImplementation(
      async (_input: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          settle = resolve;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { onResult } = start(environment(), refresh);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(refresh.mock.calls[0]![1].aborted).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    settle(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("aborts disposed scopes and ignores their late results", async () => {
    let settle!: (value: unknown) => void;
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { onResult } = start(environment(), refresh);
    stops.pop()!();
    expect(refresh.mock.calls[0]![1].aborted).toBe(true);
    settle(changed);
    await vi.advanceTimersByTimeAsync(30000);
    expect(onResult).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, 2700],
    [1, 3300],
  ])("applies jitter to the 3-second interval (random=%s)", async (random, delay) => {
    const { refresh } = start(environment(), undefined, undefined, () => random);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("关系事实的读取调度", () => {
  function startRelations() {
    const read = vi.fn();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const reads = createRelationReads({
      read,
      intervalMs: 5000,
      environment: { document, window: { setInterval, clearInterval } },
    });
    stops.push(() => reads.stop());
    return { read, document, reads };
  }

  it("没有 revision 来源时退回五秒定时读，并且在隐藏时不发请求", async () => {
    const { read, document, reads } = startRelations();
    reads.sync(undefined);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(15000);
    expect(read).toHaveBeenCalledTimes(2);
    document.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("给了 revision 就不定时读，只有 revision 变化才重读", async () => {
    const { read, reads } = startRelations();
    reads.sync("r1");
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(1);
    reads.sync("r1");
    expect(read).toHaveBeenCalledTimes(1);
    reads.sync("r2");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("revision 从 null 变成有值也补读一次", async () => {
    const { read, reads } = startRelations();
    reads.sync(null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(1);
    reads.sync("r1");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("重新可见时补读一次，隐藏期间不读", async () => {
    const { read, document, reads } = startRelations();
    reads.sync("r1");
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("停止后既不定时读也不再响应可见性变化", async () => {
    const { read, document, reads } = startRelations();
    reads.sync("r1");
    reads.stop();
    await vi.advanceTimersByTimeAsync(30000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("机器范围的 revision 读取调度", () => {
  function startActivity(read = vi.fn().mockResolvedValue("r1")) {
    const onRevision = vi.fn();
    const onError = vi.fn();
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    stops.push(
      createMachineActivityPolling({
        read,
        intervalMs: 3000,
        environment: { document, window: { setTimeout, clearTimeout } },
        onRevision,
        onError,
      }),
    );
    return { read, onRevision, onError, document };
  }

  it("可见时每三秒读一次，revision 没变就不上报", async () => {
    const { read, onRevision } = startActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onRevision).toHaveBeenCalledWith("r1", null);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onRevision).toHaveBeenCalledTimes(1);
  });

  it("隐藏时不发请求，回到可见立刻补读一次", async () => {
    const { read, document } = startActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("同一时刻只有一个请求在途，可见性抖动不叠请求", async () => {
    let settle!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>((done) => (settle = done)));
    const { document } = startActivity(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(1);
    settle("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("读失败保留上一次 revision，恢复后变化才上报", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce({ code: "internal", message: "boom", requestId: "req_1" })
      .mockResolvedValueOnce("r1")
      .mockResolvedValue("r2");
    const { onRevision, onError } = startActivity(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onRevision).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onRevision).toHaveBeenCalledWith("r1", null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onRevision).toHaveBeenLastCalledWith("r2", "r1");
  });

  it("停止后不再定时读，也不再响应可见性变化", async () => {
    const { read, document } = startActivity();
    await vi.advanceTimersByTimeAsync(0);
    stops.pop()!();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("机器页整页重取的调度", () => {
  function startRefresh(refresh = vi.fn().mockResolvedValue(undefined)) {
    const document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const schedule = createMachineRefreshSchedule({
      refresh,
      intervalMs: 5000,
      environment: { document, window: { setTimeout, clearTimeout } },
    });
    stops.push(() => schedule.stop());
    return { refresh, document, schedule };
  }

  it("没有 revision 来源时保持五秒定时重取，隐藏期间不重取", async () => {
    const { refresh, document, schedule } = startRefresh();
    schedule.sync(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("给了 revision 就不起定时器，只有 revision 真的变化才重取", async () => {
    const { refresh, schedule } = startRefresh();
    schedule.sync(null);
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).not.toHaveBeenCalled();
    schedule.sync("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    schedule.sync("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    schedule.sync("r2");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("重新可见立刻补取一次，隐藏期间不取", async () => {
    const { refresh, document, schedule } = startRefresh();
    schedule.sync(null);
    schedule.sync("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("重取还在路上时 revision 再变，只补一次而不是并发跑两次", async () => {
    let settle!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => (settle = done)));
    const { schedule } = startRefresh(refresh);
    schedule.sync(null);
    schedule.sync("r1");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    schedule.sync("r2");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("停止后既不定时重取也不再响应可见性变化", async () => {
    const { refresh, document, schedule } = startRefresh();
    schedule.sync(undefined);
    schedule.stop();
    await vi.advanceTimersByTimeAsync(30000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
