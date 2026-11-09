import { afterAll, expect, it } from "vite-plus/test";
import type { FeishuTransportConfig } from "../src/contracts/feishu-channel";
import type {
  FeishuClientFactory,
  FeishuConnectionCallbacks,
  FeishuDispatcherFactory,
  FeishuEpochLifecycle,
  FeishuWsClientLike,
} from "../src/server/feishu/owner";
import type { FeishuHttpTransport } from "../src/server/feishu/emission";
import { channelNativeFixture } from "./fixtures/channel-native";

// fixture 先落 DATABASE_URL，再动态导入任何会碰到 db/config 的模块，
// 否则模块级 config 会读到默认的 ./data/sprout.sqlite。
const f = await channelNativeFixture();
const { createFeishuDeliveryLoop } = await import("../src/server/feishu/delivery-loop");
const { createFeishuRuntime } = await import("../src/server/feishu/runtime");
afterAll(() => f.close());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

const config: FeishuTransportConfig = Object.freeze({
  appId: "cli_0123456789abcdef",
  appSecret: "local-test-secret",
  origin: "http://feishu.invalid",
  enabled: true,
});

/** 回环替身：token 立即返回，消息请求按脚本回应，从不触网。 */
function fakeTransport(): FeishuHttpTransport {
  return (input) =>
    input.url.includes("tenant_access_token")
      ? {
          initiated: true,
          response: Promise.resolve({
            status: 200,
            body: JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }),
          }),
          abort: () => {},
        }
      : {
          initiated: true,
          response: Promise.resolve({
            status: 200,
            body: JSON.stringify({ code: 0, data: { message_id: "om_runtime" } }),
          }),
          abort: () => {},
        };
}

function fakeClientFactory(log: { closed: boolean }, callbacks: FeishuConnectionCallbacks[]) {
  return ((callbacks_) => {
    callbacks.push(callbacks_);
    return {
      start: () => {
        callbacks_.onReady();
      },
      close: () => {
        log.closed = true;
      },
      getConnectionStatus: () => ({ state: "connected" }),
    } satisfies FeishuWsClientLike;
  }) satisfies FeishuClientFactory;
}

const dispatcher: FeishuDispatcherFactory = () => ({ register: () => undefined });

it("runs exactly one delivery tick at a time and stops on demand", async () => {
  let calls = 0;
  let release = () => {};
  const gate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const loop = createFeishuDeliveryLoop({
    intervalMs: 5,
    maxPerTick: 1,
    emit: async () => {
      calls += 1;
      await gate();
      return "row";
    },
  });
  loop.start();
  await waitFor(() => calls === 1);
  await sleep(30);
  expect(calls).toBe(1);
  release();
  await waitFor(() => calls >= 2);
  release();
  loop.stop();
  loop.stop();
  const afterStop = calls;
  await sleep(30);
  expect(calls).toBe(afterStop);
  expect(loop.isRunning()).toBe(false);
});

it("wakes a long idle interval immediately and keeps polling after a failing tick", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const loop = createFeishuDeliveryLoop({
    intervalMs: 60_000,
    emit: async () => {
      calls += 1;
      throw new Error("boom");
    },
    onError: (error) => errors.push(error),
  });
  loop.start();
  // start 立即跑一次，之后空闲轮询间隔很长。
  await waitFor(() => calls >= 1);
  const afterStart = calls;
  await sleep(50);
  expect(calls).toBe(afterStart);
  loop.wake();
  await waitFor(() => calls > afterStart);
  // 失败不会让循环退出：wake 仍能继续调度新的 tick。
  const afterWake = calls;
  loop.wake();
  await waitFor(() => calls > afterWake);
  expect(errors.length).toBeGreaterThanOrEqual(afterWake);
  loop.stop();
});

it("stays completely inert when Feishu is not configured", async () => {
  let created = 0;
  const runtime = createFeishuRuntime({
    config: { ...config, enabled: false },
    createClient: () => {
      created += 1;
      throw new Error("must not be created");
    },
  });
  runtime.start();
  expect(runtime.isRunning()).toBe(false);
  expect(runtime.snapshot().phase).toBe("disabled");
  expect(created).toBe(0);
  runtime.stop();
});

it("wakes delivery capture as soon as an assistant reply is committed", () => {
  const s = f.scenario();
  s.bind();
  const wakes: number[] = [];
  f.delivery.setFeishuDeliveryWake(() => wakes.push(Date.now()));
  try {
    s.reply("捕获后立刻叫醒投递");
    expect(wakes.length).toBeGreaterThan(0);
  } finally {
    f.delivery.setFeishuDeliveryWake(null);
  }
  // 没有装配钩子时捕获照常提交，唤醒只是退化为空闲轮询。
  expect(() => s.reply("没有钩子也不会失败")).not.toThrow();
});

it("assembles owner, port and loop behind enabled config and delivers on wake", async () => {
  const s = f.scenario();
  s.bind();
  s.reply("运行时装配成功");
  const delivery = f.sqlite
    .prepare(
      "SELECT * FROM channel_delivery WHERE json_extract(route,'$.chatId')=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(s.dm.id) as { id: string; state: string };
  f.sqlite
    .prepare("UPDATE channel_delivery SET state='failed' WHERE id<>? AND state='ready'")
    .run(delivery.id);

  const log = { closed: false };
  const callbacks: FeishuConnectionCallbacks[] = [];
  const errors: unknown[] = [];
  const runtime = createFeishuRuntime({
    config,
    transport: fakeTransport(),
    createClient: fakeClientFactory(log, callbacks),
    createDispatcher: dispatcher,
    now: () => s.now,
    requestId: () => "req_runtime",
    onError: (error) => errors.push(error),
  });
  runtime.start();
  expect(runtime.isRunning()).toBe(true);
  expect(runtime.snapshot().phase).toBe("connected");
  runtime.wake();
  await waitFor(() => {
    const state = (
      f.sqlite.prepare("SELECT state FROM channel_delivery WHERE id=?").get(delivery.id) as {
        state: string;
      }
    ).state;
    return state === "accepted";
  });
  expect(errors).toEqual([]);
  runtime.stop();
  expect(log.closed).toBe(true);
  expect(runtime.isRunning()).toBe(false);
});

it("reports a start failure without leaking the client or an unhandled rejection", async () => {
  const errors: unknown[] = [];
  const runtime = createFeishuRuntime({
    config,
    transport: fakeTransport(),
    createClient: () => {
      throw new Error("ws bootstrap failed");
    },
    createDispatcher: dispatcher,
    onError: (error) => errors.push(error),
  });
  runtime.start();
  expect(errors.length).toBe(1);
  expect((errors[0] as Error).message).toBe("ws bootstrap failed");
  expect(runtime.snapshot().phase).toBe("failed");
  expect(runtime.snapshot().error).toBe("start_failed");
  runtime.stop();
  expect(runtime.snapshot().phase).toBe("disabled");
});

it("starts again after a failed assembly instead of staying half-initialized", () => {
  const errors: unknown[] = [];
  const callbacks: FeishuConnectionCallbacks[] = [];
  const log = { closed: false };
  let attempts = 0;
  const runtime = createFeishuRuntime({
    config,
    transport: fakeTransport(),
    createClient: fakeClientFactory(log, callbacks),
    createDispatcher: dispatcher,
    lifecycle: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("lifecycle bootstrap failed");
      return {
        ready: () => "ep_retry",
        reconnected: () => "ep_retry",
        disconnected: () => {},
      } as unknown as FeishuEpochLifecycle;
    },
    onError: (error) => errors.push(error),
  });
  runtime.start();
  expect(runtime.isRunning()).toBe(false);
  expect(runtime.snapshot().phase).toBe("failed");
  expect(runtime.snapshot().error).toBe("start_failed");

  runtime.start();
  expect(errors.length).toBe(1);
  expect(runtime.isRunning()).toBe(true);
  expect(runtime.snapshot().error).toBeNull();
  expect(runtime.snapshot().phase).toBe("connected");
  runtime.stop();
});

it("does not pretend to be disabled when assembly fails before the owner exists", () => {
  const errors: unknown[] = [];
  const runtime = createFeishuRuntime({
    config,
    transport: fakeTransport(),
    createClient: () => {
      throw new Error("unused");
    },
    createDispatcher: dispatcher,
    lifecycle: () => {
      throw new Error("lifecycle bootstrap failed");
    },
    onError: (error) => errors.push(error),
  });
  runtime.start();
  expect(errors.length).toBe(1);
  // 配置是开着的，只是没装配起来：快照必须说失败，而不是「未启用」。
  expect(runtime.snapshot().phase).toBe("failed");
  expect(runtime.snapshot().error).toBe("start_failed");
  expect(runtime.snapshot().appId).toBe(config.appId);
  runtime.stop();
  expect(runtime.snapshot()).toEqual({
    appId: null,
    phase: "disabled",
    generation: 0,
    epochId: null,
    error: null,
    changedAtMs: 0,
  });
});
