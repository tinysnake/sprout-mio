import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fail, ok, type AppErrorCode } from "../src/contracts/result";
import type { LeaseMutationInput } from "../src/contracts/lease";
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

// Only the mutation fields matter to receipt delivery; all reads use the same lease snapshot.
const snapshot = { lease: null, mutation: null };
const receipt = {
  mutationId: "lmu_55555555-5555-4555-8555-555555555555",
  projectId: input.projectId,
  machineId: input.machineId,
  action: "acquire" as const,
  state: "completed" as const,
  generation: 1,
  holderInstanceId: "ins_66666666-6666-4666-8666-666666666666",
};

function deny(code: AppErrorCode) {
  return fail({ code, message: "安全边界拒绝", requestId: readRequestId });
}

describe("Project 租约收据等待", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(sendMessageFn).mockResolvedValue(ok({ id: "message" } as never, "req_message-send"));
    read.mockResolvedValue(ok(snapshot as never, readRequestId));
    getLease.mockResolvedValue(ok(snapshot as never, readRequestId));
  });
  afterEach(() => vi.useRealTimers());

  it("等待到期后重新核对租约和 mutation，已 completed 就返回收据并刷新", async () => {
    // The final reconciliation starts with a fresh lease read, after ordinary polling expires.
    getLease.mockImplementation(async () => {
      read.mockResolvedValue(ok({ ...snapshot, mutation: receipt } as never, readRequestId));
      return ok(snapshot as never, readRequestId);
    });
    const pending = requestProjectLease(input, chatId, invalidate);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: true, data: receipt });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("一直读不到收据时只报告未确认，用动作 requestId 核对服务端记录", async () => {
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
      read.mockResolvedValueOnce(deny(code)).mockResolvedValueOnce(
        ok({ ...snapshot, mutation: receipt } as never, readRequestId),
      );
      const pending = requestProjectLease(input, chatId, invalidate);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ ok: true, data: receipt });
      expect(invalidate).toHaveBeenCalledOnce();
    },
  );
});
