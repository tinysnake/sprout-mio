// I-P8b 的纯域验收（不落库）：等待判定、时长参数与钳断、时限默认值与项目级覆盖、
// 「等待期间该身份不接其他工作」。这些是 T1/N1–N8 里不依赖数据库的那几面。
import { expect, test } from "vite-plus/test";
import {
  DEFAULT_LEASE_TIMEOUTS,
  LEASE_ESCALATION_DEFAULT_MS,
  LEASE_TIMEOUT_DEFAULT_MS,
  LEASE_WAIT_MAX_MS,
  LEASE_WAIT_SUGGESTED_MS,
  clampLeaseWaitMs,
  resolveLeaseTimeouts,
} from "../src/contracts/lease-timeout";
import { leaseWaitBusy, leaseWaitTarget, waitForLease } from "../src/domain/lease-wait";

type View = Parameters<typeof leaseWaitTarget>[0];
const heldBy = (instanceId: string): View => ({
  state: "held",
  holderInstanceId: instanceId,
  escrow: null,
});
const escrowed = (id: string): View => ({
  state: "held",
  holderInstanceId: "ins_holder",
  escrow: {
    escrowId: id,
    state: "escrowed",
    targetAgentProfileId: null,
    escrowedByInstanceId: "ins_holder",
  },
});

test("时限默认是 30 分钟与 2 小时，项目级覆盖可压到秒级", () => {
  expect(DEFAULT_LEASE_TIMEOUTS).toEqual({ timeoutMs: 1_800_000, escalationMs: 7_200_000 });
  expect(LEASE_TIMEOUT_DEFAULT_MS).toBe(1_800_000);
  expect(LEASE_ESCALATION_DEFAULT_MS).toBe(7_200_000);
  expect(resolveLeaseTimeouts(undefined)).toEqual(DEFAULT_LEASE_TIMEOUTS);
  expect(resolveLeaseTimeouts({})).toEqual(DEFAULT_LEASE_TIMEOUTS);
  // JSON 列里的旧行没有这个字段、或被写坏，都必须回落到默认值，而不是让读取失败。
  expect(resolveLeaseTimeouts({ other: true })).toEqual(DEFAULT_LEASE_TIMEOUTS);
  expect(resolveLeaseTimeouts({ timeoutMs: 1_000 })).toEqual(DEFAULT_LEASE_TIMEOUTS);
  expect(resolveLeaseTimeouts({ timeoutMs: 1_000, escalationMs: 2_000 })).toEqual({
    timeoutMs: 1_000,
    escalationMs: 2_000,
  });
  expect(resolveLeaseTimeouts({ timeoutMs: 10, escalationMs: 2_000 })).toEqual(
    DEFAULT_LEASE_TIMEOUTS,
  );
});

test("等待时长：默认建议 5 分钟，超过 1 小时一律钳到 1 小时，且有下限", () => {
  expect(LEASE_WAIT_SUGGESTED_MS).toBe(300_000);
  expect(LEASE_WAIT_MAX_MS).toBe(3_600_000);
  expect(clampLeaseWaitMs(undefined)).toBe(LEASE_WAIT_SUGGESTED_MS);
  expect(clampLeaseWaitMs(Number.NaN)).toBe(LEASE_WAIT_SUGGESTED_MS);
  expect(clampLeaseWaitMs(-1)).toBe(1_000);
  expect(clampLeaseWaitMs(0)).toBe(1_000);
  expect(clampLeaseWaitMs(600_000)).toBe(600_000);
  expect(clampLeaseWaitMs(LEASE_WAIT_MAX_MS + 1)).toBe(LEASE_WAIT_MAX_MS);
  expect(clampLeaseWaitMs(24 * 3_600_000)).toBe(LEASE_WAIT_MAX_MS);
});

test("只对「被其他分身持有」或「仍在挂靠中且有对象」进入等待", () => {
  expect(leaseWaitTarget(heldBy("ins_other"), "ins_me")).toEqual({
    kind: "wait",
    reason: "held_by_other",
    holderInstanceId: "ins_other",
  });
  expect(leaseWaitTarget(escrowed("les_1"), "ins_me")).toEqual({
    kind: "wait",
    reason: "escrowed",
    escrowId: "les_1",
  });
  expect(
    leaseWaitTarget({ state: "free", holderInstanceId: null, escrow: null }, "ins_me"),
  ).toEqual({
    kind: "no_target",
    reason: "free",
  });
  expect(leaseWaitTarget(heldBy("ins_me"), "ins_me")).toEqual({
    kind: "no_target",
    reason: "already_held",
  });
});

test("等待阻塞到点返回失败 + 原因，期间只读、不打扰持有者", async () => {
  let reads = 0;
  let slept = 0;
  let clock = 0;
  const result = await waitForLease<View>({
    requesterInstanceId: "ins_me",
    requestedMs: 1_000,
    pollMs: 400,
    deps: {
      readLease: () => {
        reads += 1;
        return heldBy("ins_other");
      },
      now: () => new Date(clock),
      sleep: async (ms) => {
        slept += ms;
        clock += ms;
      },
    },
  });
  expect(result).toEqual({ ok: false, reason: "timed_out" });
  expect(slept).toBe(1_000);
  expect(reads).toBe(4);
});

test("拿到或不再有对象就立即结束，不做多余等待", async () => {
  let clock = 0;
  let sleeps = 0;
  const free = await waitForLease<View>({
    requesterInstanceId: "ins_me",
    requestedMs: 1_000,
    deps: {
      readLease: () => ({ state: "free", holderInstanceId: null, escrow: null }),
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps += 1;
        clock += ms;
      },
    },
  });
  expect(free).toEqual({
    ok: true,
    lease: { state: "free", holderInstanceId: null, escrow: null },
  });
  expect(sleeps).toBe(0);

  const takenOver = await waitForLease<View>({
    requesterInstanceId: "ins_me",
    requestedMs: 1_000,
    deps: {
      readLease: () => (clock === 0 ? heldBy("ins_other") : heldBy("ins_me")),
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps += 1;
        clock += ms;
      },
    },
  });
  expect(takenOver.ok).toBe(true);
  expect(sleeps).toBe(1);
});

test("等待期间该身份不接其他工作：同身份的第二次等待被拒为 identity_busy", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve as () => void;
  });
  let clock = 0;
  const first = waitForLease<View>({
    requesterInstanceId: "ins_me",
    requestedMs: 60_000,
    deps: {
      readLease: () => heldBy("ins_other"),
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
        await gate;
      },
    },
  });
  await Promise.resolve();
  expect(leaseWaitBusy("ins_me")).toBe(true);
  const second = await waitForLease<View>({
    requesterInstanceId: "ins_me",
    deps: {
      readLease: () => heldBy("ins_me"),
      now: () => new Date(0),
      sleep: async () => {},
    },
  });
  expect(second).toEqual({ ok: false, reason: "identity_busy" });
  // 另一个身份不受影响：等待是每个身份自己的事。
  expect(leaseWaitBusy("ins_other")).toBe(false);
  release!();
  const settled = await first;
  expect(settled.ok).toBe(false);
  expect(leaseWaitBusy("ins_me")).toBe(false);
});
