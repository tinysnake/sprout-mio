import { afterAll, expect, it } from "vite-plus/test";
import type { FeishuTransportConfig } from "../src/contracts/feishu-channel";
import type {
  FeishuClientFactory,
  FeishuConnectionCallbacks,
  FeishuDispatcherFactory,
  FeishuWsClientLike,
} from "../src/server/feishu/owner";
import type { FeishuHttpTransport } from "../src/server/feishu/emission";
import { channelNativeFixture } from "./fixtures/channel-native";

const f = await channelNativeFixture();
const { createFeishuLease } = await import("../src/server/feishu/lease");
const { createFeishuRuntime } = await import("../src/server/feishu/runtime");
afterAll(() => f.close());

const TTL_MS = 20_000;
let clock = Date.parse("2026-11-11T02:00:00.000Z");
const now = () => new Date(clock);

const config: FeishuTransportConfig = Object.freeze({
  appId: "cli_lease0123456789ab",
  appSecret: "{{SECRET_yjfwudku}}",
  origin: "http://feishu.invalid",
  enabled: true,
});

const transport: FeishuHttpTransport = (input) =>
  input.url.includes("tenant_access_token")
    ? {
        initiated: true,
        response: Promise.resolve({
          status: 200,
          body: JSON.stringify({ code: 0, tenant_access_token: "t-lease", expire: 7200 }),
        }),
        abort: () => {},
      }
    : {
        initiated: true,
        response: Promise.resolve({
          status: 200,
          body: JSON.stringify({ code: 0, data: { message_id: "om_lease" } }),
        }),
        abort: () => {},
      };

function fakeClients(log: { closed: number }, callbacks: FeishuConnectionCallbacks[]) {
  return ((callbacks_) => {
    callbacks.push(callbacks_);
    return {
      start: () => callbacks_.onReady(),
      close: () => {
        log.closed += 1;
      },
      getConnectionStatus: () => ({ state: "connected" }),
    } satisfies FeishuWsClientLike;
  }) satisfies FeishuClientFactory;
}

const dispatcher: FeishuDispatcherFactory = () => ({ register: () => undefined });

it("keeps a live app out of a second instance and refills it after release", () => {
  const first = createFeishuLease({ appId: config.appId, now, ttlMs: TTL_MS });
  const second = createFeishuLease({ appId: config.appId, now, ttlMs: TTL_MS });
  expect(first.claim()).toBe("acquired");
  expect(second.claim()).toBe("held");
  expect(first.renew()).toBe(true);
  expect(second.renew()).toBe(false);
  first.release();
  expect(second.claim()).toBe("acquired");
  second.release();
});

it("lets another instance take over once the holder stops renewing", () => {
  const appId = "cli_lease_expired0123";
  const first = createFeishuLease({ appId, now, ttlMs: TTL_MS });
  expect(first.claim()).toBe("acquired");
  clock += TTL_MS + 1;
  const second = createFeishuLease({ appId, now, ttlMs: TTL_MS });
  expect(second.claim()).toBe("acquired");
  expect(first.renew()).toBe(false);
  second.release();
});

it("treats a repeated claim by the same holder as already acquired", () => {
  const appId = "cli_lease_sameholder";
  const lease = createFeishuLease({ appId, now, ttlMs: TTL_MS });
  expect(lease.claim()).toBe("acquired");
  expect(lease.claim()).toBe("acquired");
  expect(lease.renew()).toBe(true);
  lease.release();
});

it("reports lease_held instead of opening a second socket, then starts once freed", () => {
  const closed = { closed: 0 };
  const callbacks: FeishuConnectionCallbacks[] = [];
  const make = () =>
    createFeishuRuntime({
      projectId: f.project.id,
      config,
      transport,
      createClient: fakeClients(closed, callbacks),
      createDispatcher: dispatcher,
      now,
    });
  const serving = make();
  const blocked = make();
  serving.start();
  expect(serving.snapshot().phase).toBe("connected");
  blocked.start();
  expect(blocked.snapshot()).toMatchObject({ phase: "failed", error: "lease_held" });
  expect(blocked.isRunning()).toBe(false);
  expect(callbacks).toHaveLength(1);
  blocked.stop();
  expect(blocked.snapshot().phase).toBe("disabled");
  serving.stop();
  blocked.start();
  expect(blocked.snapshot().phase).toBe("connected");
  blocked.stop();
  expect(closed.closed).toBe(2);
});
