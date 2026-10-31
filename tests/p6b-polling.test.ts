import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createInfoHubPolling } from "../src/components/info-hub/use-info-hub-polling";
import type { InfoHubRefreshInput } from "../src/contracts/info-hub-query";

// Risk → evidence: background traffic / stale resume / overlap / retry storms /
// disconnect recovery / disposed context writes. Fake clocks drive actual requests.
const projectId = "prj_11111111-1111-4111-8111-111111111111";
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
