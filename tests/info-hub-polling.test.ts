import { describe, expect, it, vi } from "vite-plus/test";
import {
  InfoHubAccessError,
  createInfoHubPolling,
  type PollingState,
} from "../src/components/info-hub/use-info-hub-polling";

type Options = Parameters<typeof createInfoHubPolling>[0];

const input = {
  projectId: "prj_ab12cd34",
  query: { view: "project", section: "agents" },
} as unknown as Options["input"];

function stubEnvironment() {
  const listeners = new Map<string, () => void>();
  const on = (type: string, listener: () => void) => listeners.set(type, listener);
  const off = (type: string) => listeners.delete(type);
  const environment = {
    document: { visibilityState: "visible", addEventListener: on, removeEventListener: off },
    window: { addEventListener: on, removeEventListener: off },
    navigator: { onLine: true },
  } as unknown as Options["environment"];
  return { environment, listeners };
}

function stubChanges(connected: () => boolean) {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    changes: {
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      connected,
    } as unknown as Options["changes"],
  };
}

describe("Info Hub 读端的推送唤醒", () => {
  it("鉴权失败之后，在途推送不再补读一次", async () => {
    vi.useFakeTimers();
    const { environment } = stubEnvironment();
    const { listeners, changes } = stubChanges(() => true);
    const failures: Array<(error: unknown) => void> = [];
    const states: PollingState[] = [];
    let attempts = 0;
    const stop = createInfoHubPolling({
      input,
      refresh: () => {
        attempts += 1;
        return new Promise((_, fail) => failures.push(fail));
      },
      onResult: () => {},
      onState: (state) => states.push(state),
      environment,
      changes,
      random: () => 0,
    });
    expect(attempts).toBe(1);
    listeners[0]();
    failures[0](new InfoHubAccessError("forbidden"));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(states.at(-1)).toBe("forbidden");
    listeners[0]();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
    stop();
  });

  it("窗口恢复解除终止状态并重新读取", async () => {
    vi.useFakeTimers();
    const { environment, listeners } = stubEnvironment();
    const { changes } = stubChanges(() => true);
    const failures: Array<(error: unknown) => void> = [];
    let attempts = 0;
    const stop = createInfoHubPolling({
      input,
      refresh: () => {
        attempts += 1;
        return new Promise((_, fail) => failures.push(fail));
      },
      onResult: () => {},
      environment,
      changes,
      random: () => 0,
    });
    failures[0](new InfoHubAccessError("forbidden"));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    listeners.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    stop();
  });

  it("推送连着时按安全间隔读，断开后退回轮询节奏", async () => {
    vi.useFakeTimers();
    const { environment } = stubEnvironment();
    async function count(connected: boolean) {
      const { changes } = stubChanges(() => connected);
      let attempts = 0;
      const stop = createInfoHubPolling({
        input,
        refresh: async () => {
          attempts += 1;
          throw new Error("network");
        },
        onResult: () => {},
        environment,
        changes,
        random: () => 0,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      stop();
      return attempts;
    }
    expect(await count(true)).toBe(1);
    expect(await count(false)).toBe(2);
    vi.useRealTimers();
  });
});
