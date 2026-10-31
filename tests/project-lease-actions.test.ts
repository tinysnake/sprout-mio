import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fail, ok, type AppErrorCode } from "../src/contracts/result";
import type { LeaseMutationInput, LeaseMutationView, LeaseView } from "../src/contracts/lease";
import { requestProjectLease } from "../src/components/machine/project-lease-actions";
import { sendMessageFn } from "../src/server/functions/chat";
import { getLeaseFn, getLeaseRequestFn } from "../src/server/functions/lease";

vi.mock("../src/server/functions/chat", () => ({ sendMessageFn: vi.fn(), listChatsFn: vi.fn() }));
vi.mock("../src/server/functions/lease", () => ({
  getLeaseFn: vi.fn(),
  getLeaseRequestFn: vi.fn(),
  reclaimLeaseFn: vi.fn(),
}));

const input: LeaseMutationInput = {
  action: "acquire",
  projectId: "prj_11111111-1111-4111-8111-111111111111",
  machineId: "mch_22222222-2222-4222-8222-222222222222",
  expectedGeneration: 0,
  requestId: "req_33333333-3333-4333-8333-333333333333",
};
const chatId = "cht_44444444-4444-4444-8444-444444444444";
const readRequestId = "req_receipt-read";
const read = vi.mocked(getLeaseRequestFn);
const getLease = vi.mocked(getLeaseFn);
const invalidate = vi.fn(async () => {});
const snapshot: { lease: LeaseView; mutation: null } = {
  lease: {
    projectId: input.projectId,
    machineId: input.machineId,
    generation: 0,
    state: "free",
    holderInstanceId: null,
    changedAt: "2026-01-01T00:00:00.000Z",
    pendingMutationId: null,
  },
  mutation: null,
};
const receipt: LeaseMutationView = {
  mutationId: "lmu_55555555-5555-4555-8555-555555555555",
  projectId: input.projectId,
  machineId: input.machineId,
  action: "acquire",
  state: "completed",
  expectedGeneration: 0,
  completedGeneration: 1,
  targetInstanceId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
};

function deny(code: Exclude<AppErrorCode, "project_member_removal_blocked">) {
  return fail({ code, message: "安全边界拒绝", requestId: readRequestId });
}

describe("Project 租约收据等待", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(sendMessageFn).mockResolvedValue(
      ok(
        {
          id: "msg_77777777-7777-4777-8777-777777777777",
          chatId,
          senderKind: "human",
          senderId: "user",
          body: "租约请求",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        "req_message-send",
      ),
    );
    read.mockResolvedValue(ok(snapshot, readRequestId));
    getLease.mockResolvedValue(ok(snapshot, readRequestId));
  });
  afterEach(() => vi.useRealTimers());

  it("等待到期后重新核对租约和 mutation，已 completed 就返回收据并刷新", async () => {
    // The final reconciliation starts with a fresh lease read, after ordinary polling expires.
    getLease.mockImplementation(async () => {
      read.mockResolvedValue(ok({ ...snapshot, mutation: receipt }, readRequestId));
      return ok(snapshot, readRequestId);
    });
    const pending = requestProjectLease(input, chatId, invalidate);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: true, data: receipt, requestId: input.requestId });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("一直读不到收据时只报告未确认，用动作 requestId 核对服务端记录", async () => {
    const started = Date.now();
    const readsAt: number[] = [];
    read.mockImplementation(async () => {
      readsAt.push(Date.now() - started);
      return ok(snapshot, readRequestId);
    });
    const pending = requestProjectLease(input, chatId, invalidate);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      requestId: input.requestId,
      error: { code: "lease_result_unconfirmed", requestId: input.requestId },
    });
    expect(result.error?.message).toContain("结果未确认");
    expect(result.error?.message).toContain(input.requestId);
    expect(readsAt.slice(0, 4)).toEqual([0, 500, 1500, 3500]);
    expect(
      Math.max(...readsAt.slice(1).map((time, index) => time - readsAt[index]!)),
    ).toBeLessThanOrEqual(2000);
    expect(Date.now() - started).toBe(180_000);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it.each(["not_found", "unauthorized", "forbidden"] as const)(
    "%s 拒绝立即返回，不等待、不重试",
    async (code) => {
      read.mockResolvedValue(deny(code));
      const started = Date.now();
      expect(await requestProjectLease(input, chatId, invalidate)).toEqual(deny(code));
      expect(Date.now()).toBe(started);
      expect(read).toHaveBeenCalledOnce();
      expect(getLease).not.toHaveBeenCalled();
    },
  );

  it.each(["internal", "too_many_requests"] as const)(
    "暂时的 %s 读取失败不会吞掉随后到达的收据",
    async (code) => {
      read
        .mockResolvedValueOnce(deny(code))
        .mockResolvedValueOnce(ok({ ...snapshot, mutation: receipt }, readRequestId));
      const pending = requestProjectLease(input, chatId, invalidate);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: true, data: receipt });
      expect(invalidate).toHaveBeenCalledOnce();
    },
  );

  it.each(["not_found", "unauthorized"] as const)(
    "最终收据重读的 %s 拒绝也不会变成成功",
    async (code) => {
      getLease.mockImplementation(async () => {
        read.mockResolvedValue(deny(code));
        return ok(snapshot, readRequestId);
      });
      const pending = requestProjectLease(input, chatId, invalidate);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual(deny(code));
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it.each(["not_found", "unauthorized"] as const)(
    "最终核对时的 %s 拒绝也立即透出，不伪装成未确认或成功",
    async (code) => {
      getLease.mockResolvedValue(deny(code));
      const pending = requestProjectLease(input, chatId, invalidate);
      await vi.runAllTimersAsync();
      expect(await pending).toEqual(deny(code));
      expect(getLease).toHaveBeenCalledOnce();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );
});
