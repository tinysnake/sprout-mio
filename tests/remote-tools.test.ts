import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { executionWaitView } from "./fixtures/execution-wait-view";
import { chatContinuationViewSchema } from "../src/contracts/chat-continuation";
import { EXECUTION_WAIT_DEFAULT_MS, EXECUTION_WAIT_MAX_MS } from "../src/contracts/tool-wait";
import { remoteToolInputSchemas } from "../src/contracts/remote";
import type { ExecutionCancellationView, ExecutionLogReadView } from "../src/contracts/remote";
import { createRemoteClient } from "../src/extension/remote-client";
import { registerRemoteTools } from "../src/extension/remote-tools";
import sproutExtension from "../src/extension/main";
import type { RemoteAgentRequest, RemoteToolGrant } from "../src/contracts/remote";
import type { LeaseView } from "../src/contracts/lease";
import type { RemoteToolClient, RemoteToolResponse } from "../src/extension/remote-client";
import type { SproutExtensionAPI } from "../src/extension/types";

const projectId = "prj_00000000";
const machineId = "mch_00000000";
const requestId = "req_00000000";
const instanceId = "ins_00000000";
const executionId = "exe_00000000";
const time = "2026-10-24T00:00:00.000Z";
const free = {
  projectId,
  machineId,
  generation: 0,
  state: "free",
  holderInstanceId: null,
  changedAt: time,
  pendingMutationId: null,
  escrow: null,
};
const denied: RemoteToolResponse = {
  outcome: "response",
  result: {
    ok: false,
    error: { code: "lease_not_holder", message: "没有租约", requestId },
    requestId,
  },
};
function tools(client: RemoteToolClient) {
  const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
  registerRemoteTools(
    {
      registerTool: (tool) => {
        registered.set(tool.name, tool);
      },
    },
    client,
  );
  return registered;
}
const base = { machineId, requestId, authorizationGeneration: 1 };
const cases = {
  sprout_lease_acquire: { machineId, requestId, expectedGeneration: 0 },
  sprout_lease_release: { machineId, requestId, expectedGeneration: 1 },
  sprout_lease_handoff: {
    machineId,
    requestId,
    expectedGeneration: 1,
    targetInstanceId: instanceId,
  },
  sprout_lease_get: { machineId },
  sprout_lease_escrow: {
    machineId,
    requestId,
    expectedGeneration: 1,
    chatId: "cnv_00000000",
  },
  sprout_lease_claim: {
    machineId,
    requestId,
    expectedGeneration: 2,
    escrowId: "les_00000000",
  },
  sprout_lease_escrow_cancel: {
    machineId,
    requestId,
    expectedGeneration: 2,
    escrowId: "les_00000000",
  },
  sprout_remote_shell: { ...base, command: "true" },
  sprout_remote_file_read: { ...base, path: "/tmp/file" },
  sprout_remote_file_write: { ...base, path: "/tmp/file", content: "fixture" },
  sprout_remote_process_list: base,
  sprout_remote_process_signal: { ...base, pid: 1234, signal: "TERM" },
  sprout_remote_execution_get: { machineId, executionId },
  sprout_remote_execution_cancel: { ...base, executionId },
  sprout_remote_execution_log: { machineId, executionId, cursor: null },
  sprout_lease_wait: { machineId },
  sprout_remote_execution_wait: { machineId, executionId },
};

describe("远端 execution 阻塞等待工具", () => {
  afterEach(() => vi.useRealTimers());

  function response(state: Parameters<typeof executionWaitView>[0]): RemoteToolResponse {
    return { outcome: "response", result: { ok: true, requestId, data: executionWaitView(state) } };
  }

  it("创建工具默认阻塞到终态，只提交一次，且 blockMs 不进入 operation", async () => {
    vi.useFakeTimers();
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response(request.call.type === "execution_submit" ? "running" : "succeeded");
      },
    }).get("sprout_remote_shell")!;
    const pending = tool.execute("probe", { ...base, command: "true" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({
      isError: false,
      details: { outcome: "succeeded", data: executionWaitView("succeeded"), requestId },
    });
    expect(requests).toEqual([
      {
        version: 2,
        call: {
          type: "execution_submit",
          input: {
            projectId,
            machineId,
            requestId,
            authorizationGeneration: 1,
            operation: { kind: "shell", command: "true", waitMs: 1000 },
          },
        },
      },
      { version: 2, call: { type: "execution_get", input: { projectId, machineId, executionId } } },
    ]);
    expect(requests.filter(({ call }) => call.type === "execution_submit")).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("blockMs");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("五个创建工具的 operation 都不带 blockMs", async () => {
    const createCases = [
      ["sprout_remote_shell", { ...base, command: "true" }],
      ["sprout_remote_file_read", { ...base, path: "/tmp/file" }],
      ["sprout_remote_file_write", { ...base, path: "/tmp/file", content: "fixture" }],
      ["sprout_remote_process_list", { ...base }],
      ["sprout_remote_process_signal", { ...base, pid: 1234, signal: "TERM" }],
    ] as const;
    for (const [name, parameters] of createCases) {
      const requests: RemoteAgentRequest[] = [];
      const tool = tools({
        projectId,
        request: async (request) => {
          requests.push(request);
          return response("succeeded");
        },
      }).get(name)!;
      await tool.execute("probe", { ...parameters, blockMs: 0 });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.call.type).toBe("execution_submit");
      expect(JSON.stringify(requests)).not.toContain("blockMs");
    }
  });

  it("预算用尽返回 pending、同一个 executionId，且不发出取消", async () => {
    vi.useFakeTimers();
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response(request.call.type === "execution_submit" ? "running" : "draining");
      },
    }).get("sprout_remote_shell")!;
    const pending = tool.execute("probe", { ...base, command: "true", blockMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await pending;
    expect(outcome.isError).toBe(false);
    expect(outcome.details).toMatchObject({
      outcome: "pending",
      reason: "wait_budget_exhausted",
      machineId,
      executionId,
      data: executionWaitView("draining"),
      requestedMs: 2_000,
      effectiveMs: 2_000,
      waitedMs: 2_000,
      continueWith: {
        tool: "sprout_remote_execution_wait",
        arguments: { machineId, executionId },
      },
      message: expect.stringContaining("没有被取消"),
    });
    expect(requests.every(({ call }) => call.type !== "execution_cancel")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blockMs 为 0 时提交后立刻返回 not_waited，不假装成超时", async () => {
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response("running");
      },
    }).get("sprout_remote_process_list")!;
    const outcome = await tool.execute("probe", { ...base, blockMs: 0 });
    expect(outcome).toMatchObject({
      isError: false,
      details: {
        outcome: "pending",
        reason: "not_waited",
        executionId,
        requestedMs: 0,
        effectiveMs: 0,
        waitedMs: 0,
        data: executionWaitView("running"),
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("创建工具的 blockMs 超过上限时钳到 900000 并如实回报 requestedMs", async () => {
    vi.useFakeTimers();
    const tool = tools({
      projectId,
      request: async (request) =>
        response(request.call.type === "execution_submit" ? "running" : "draining"),
    }).get("sprout_remote_shell")!;
    const pending = tool.execute("probe", { ...base, command: "true", blockMs: 9_999_999 });
    await vi.advanceTimersByTimeAsync(EXECUTION_WAIT_MAX_MS);
    expect(await pending).toMatchObject({
      isError: false,
      details: {
        outcome: "pending",
        reason: "wait_budget_exhausted",
        requestedMs: 9_999_999,
        effectiveMs: EXECUTION_WAIT_MAX_MS,
        waitedMs: EXECUTION_WAIT_MAX_MS,
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("复用的续等工具注入 Project，终态结果与单次查询同形", async () => {
    vi.useFakeTimers();
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response("succeeded");
      },
    }).get("sprout_remote_execution_wait")!;
    const pending = tool.execute("probe", { machineId, executionId });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({
      isError: false,
      details: { outcome: "succeeded", data: executionWaitView("succeeded"), requestId },
    });
    expect(requests).toEqual([
      {
        version: 2,
        call: { type: "execution_get", input: { projectId, machineId, executionId } },
      },
    ]);
  });

  it("sprout_remote_execution_wait 用 blockMs 接续等待到终态", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const tool = tools({
      projectId,
      request: async () => {
        reads += 1;
        return response(reads === 1 ? "running" : "succeeded");
      },
    }).get("sprout_remote_execution_wait")!;
    const pending = tool.execute("probe", { machineId, executionId, blockMs: 5_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({
      isError: false,
      details: { outcome: "succeeded", data: executionWaitView("succeeded"), requestId },
    });
    expect(reads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sprout_remote_execution_wait 默认等 10 分钟，到点返回最后的非终态视图", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const tool = tools({
      projectId,
      request: async () => {
        reads += 1;
        return response("running");
      },
    }).get("sprout_remote_execution_wait")!;
    const pending = tool.execute("probe", { machineId, executionId });
    await vi.advanceTimersByTimeAsync(EXECUTION_WAIT_DEFAULT_MS);
    expect(await pending).toMatchObject({
      isError: true,
      details: {
        outcome: "timed_out",
        data: executionWaitView("running"),
        requestedMs: EXECUTION_WAIT_DEFAULT_MS,
        waitedMs: EXECUTION_WAIT_DEFAULT_MS,
        message: expect.stringContaining("没有被取消"),
      },
    });
    // 每 1 秒读一次，含截止时刻那一次。
    expect(reads).toBe(EXECUTION_WAIT_DEFAULT_MS / 1_000 + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("请求失败或不可信的视图立即返回工具错误，不继续轮询", async () => {
    let reads = 0;
    const tool = tools({
      projectId,
      request: async () => {
        reads += 1;
        return denied;
      },
    }).get("sprout_remote_execution_wait")!;
    expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
      isError: true,
      details: { outcome: "failed" },
    });
    expect(reads).toBe(1);
  });

  it("取消只中断等待，不取消远程执行", async () => {
    const controller = new AbortController();
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response("running");
      },
    }).get("sprout_remote_execution_wait")!;
    const pending = tool.execute("probe", { machineId, executionId }, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      isError: false,
      details: { outcome: "cancelled" },
    });
    expect(requests.every(({ call }) => call.type !== "execution_cancel")).toBe(true);
  });

  it("sprout_remote_execution_get 保持单次读取，且不接受 blockMs", async () => {
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response("running");
      },
    }).get("sprout_remote_execution_get")!;
    expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
      isError: false,
      details: { outcome: "running", data: executionWaitView("running"), requestId },
    });
    expect(requests).toHaveLength(1);
    expect(await tool.execute("probe", { machineId, executionId, blockMs: 5_000 })).toMatchObject({
      isError: true,
      details: { outcome: "failed", error: { code: "validation_failed" } },
    });
    expect(requests).toHaveLength(1);
  });

  it("旧 waitMs 被拒绝，错误指向 blockMs", async () => {
    const createTool = tools({ projectId, request: async () => denied }).get(
      "sprout_remote_shell",
    )!;
    expect(
      await createTool.execute("probe", { ...base, command: "true", waitMs: 1_000 }),
    ).toMatchObject({
      isError: true,
      details: {
        outcome: "failed",
        error: { code: "validation_failed", message: expect.stringContaining("blockMs") },
      },
    });
    const waitTool = tools({ projectId, request: async () => denied }).get(
      "sprout_remote_execution_wait",
    )!;
    expect(
      await waitTool.execute("probe", { machineId, executionId, waitMs: 1_000 }),
    ).toMatchObject({
      isError: true,
      details: {
        outcome: "failed",
        error: { code: "validation_failed", message: expect.stringContaining("blockMs") },
      },
    });
  });

  it("等待被中止时返回 pending 并保留 executionId，不取消远程执行", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const requests: RemoteAgentRequest[] = [];
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return response("running");
      },
    }).get("sprout_remote_shell")!;
    const pending = tool.execute(
      "probe",
      { ...base, command: "true", blockMs: 60_000 },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await pending).toMatchObject({
      isError: false,
      details: { outcome: "pending", reason: "aborted", machineId, executionId },
    });
    expect(requests.every(({ call }) => call.type !== "execution_cancel")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("不带 machineId 的 Project 作用域工具照旧直达客户端，不被阻塞路径的作用域校验挡住", async () => {
    const requests: RemoteAgentRequest[] = [];
    const data = chatContinuationViewSchema.parse({
      projectId,
      chatId: "cnv_00000000",
      mode: "off",
      epoch: 1,
      revision: 1,
      owner: { kind: "human", id: "hum_00000000" },
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
    });
    const tool = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return { outcome: "response", result: { ok: true, requestId, data } };
      },
    }).get("sprout_chat_continuation_get")!;
    const probe = await tool.execute("probe", {});
    expect(requests.map(({ call }) => call.type)).toEqual(["chat_continuation_get"]);
    expect(probe.isError).toBe(false);
  });

  it("sprout_remote_execution_wait 保留在注册表并改用 blockMs", () => {
    const registered = tools({ projectId, request: async () => denied });
    expect(registered.has("sprout_remote_execution_wait")).toBe(true);
    expect(Object.keys(remoteToolInputSchemas)).toContain("sprout_remote_execution_wait");
    expect([...registered.keys()]).toEqual(Object.keys(remoteToolInputSchemas));
    const parameters = registered.get("sprout_remote_execution_wait")!.parameters;
    const keys = Object.keys((parameters.properties ?? {}) as Record<string, unknown>);
    expect(keys).toContain("blockMs");
    expect(keys).not.toContain("waitMs");
  });
});

describe("远端 Pi 工具边界", () => {
  it("每个工具强制 Machine，身份不可由参数冒充，合法输入只注入宿主 Project", async () => {
    const requests: RemoteAgentRequest[] = [];
    const registered = tools({
      projectId,
      request: async (request) => {
        requests.push(request);
        return denied;
      },
    });
    expect([...registered.keys()]).toEqual(Object.keys(remoteToolInputSchemas));
    let accepted = 0;
    for (const [name, parameters] of Object.entries(cases)) {
      const tool = registered.get(name)!;
      expect(tool.parameters.required).toContain("machineId");
      expect(tool.parameters.additionalProperties).toBe(false);
      const { machineId: _machine, ...missing } = parameters;
      for (const bad of [
        missing,
        { ...parameters, machineId: "bad" },
        { ...parameters, instanceId },
        { ...parameters, projectId: "prj_11111111" },
      ]) {
        const result = await tool.execute("probe", bad);
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({
          outcome: "failed",
          error: { code: "validation_failed" },
        });
      }
      expect(requests).toHaveLength(accepted);
      await tool.execute("probe", parameters);
      accepted += 1;
      expect(requests.at(-1)?.call.input).toMatchObject({ projectId, machineId });
      expect(requests.at(-1)?.call.input).not.toHaveProperty("instanceId");
    }
    expect(requests.map(({ call }) => call.type)).toEqual([
      "lease_mutate",
      "lease_mutate",
      "lease_mutate",
      "lease_get",
      "lease_mutate",
      "lease_mutate",
      "lease_mutate",
      ...Array(5).fill("execution_submit"),
      "execution_get",
      "execution_cancel",
      "execution_log_read",
      "lease_get",
      "execution_get",
    ]);
    // 挂靠 / 领取 / 撤销挂靠走同一个 lease_mutate 通道，action 由工具名推导。
    expect(
      requests
        .slice(4, 7)
        .map(({ call }) => (call.type === "lease_mutate" ? call.input.action : null)),
    ).toEqual(["escrow", "claim", "escrow_cancel"]);
    expect(requests[4]!.call.input).toMatchObject({
      chatId: "cnv_00000000",
      expectedGeneration: 1,
    });
    const shell = requests[7]!.call;
    expect(shell).toMatchObject({
      type: "execution_submit",
      input: {
        authorizationGeneration: 1,
        operation: { kind: "shell", command: "true", waitMs: 1000 },
      },
    });
  });

  it("成功、非终态、失败、超时和未知结果保留含义及 SDK 错误标记", async () => {
    let response: RemoteToolResponse = denied;
    const tool = tools({ projectId, request: async () => response }).get(
      "sprout_remote_execution_get",
    )!;
    for (const state of [
      "queued",
      "dispatched",
      "running",
      "draining",
      "succeeded",
      "failed",
      "rejected",
      "timed_out",
      "unknown",
    ] as const) {
      response = {
        outcome: "response",
        result: {
          ok: true,
          requestId,
          data: {
            projectId,
            machineId,
            executionId,
            state,
            authorizationGeneration: 1,
            holderInstanceId: instanceId,
            authority: "holder",
            currentAuthorizationGeneration: 1,
            runId: "run_00000000",
            chatId: "cnv_00000000",
            requestId,
            operation: { kind: "shell", command: "true", waitMs: 0 },
            createdAt: time,
            dispatchDeadlineAt: "2026-10-24T00:01:00.000Z",
            runtimeDeadlineAt: null,
            maxRuntimeMs: null,
            dispatchConnectionGeneration: 1,
            dispatchSeq: 1,
            dispatchedAt: time,
            drainedAt: null,
            payloadHash: "a".repeat(64),
            terminalAt: null,
            failureReason: null,
            recoveryReason: null,
            result: null,
            logState: "none" as const,
            producedThroughSequence: null,
            acknowledgedThroughSequence: null,
            availableFromSequence: null,
            cancellation: null,
          },
        },
      };
      const result = await tool.execute("probe", { machineId, executionId });
      expect(result.details.outcome).toBe(state);
      expect(result.isError).toBe(["failed", "rejected", "timed_out", "unknown"].includes(state));
    }
    response = denied;
    expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
      isError: true,
      details: { outcome: "failed", error: { code: "lease_not_holder" } },
    });
    response = { outcome: "unknown", reason: "transport_timeout" };
    expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
      isError: true,
      details: { outcome: "unknown", reason: "transport_timeout" },
    });
  });

  it("释放或交接的 pending 回执仍表示未完成", async () => {
    const data = {
      projectId,
      machineId,
      mutationId: "lmu_00000000",
      action: "release" as const,
      state: "pending" as const,
      expectedGeneration: 1,
      completedGeneration: null,
      targetInstanceId: null,
      createdAt: time,
      completedAt: null,
    };
    const tool = tools({
      projectId,
      request: async () => ({ outcome: "response", result: { ok: true, requestId, data } }),
    }).get("sprout_lease_release")!;
    expect(await tool.execute("probe", cases.sprout_lease_release)).toMatchObject({
      isError: false,
      details: { outcome: "pending", data: { state: "pending" } },
    });
  });

  it("挂靠、领取、撤销挂靠按挂靠契约解码，不冒充 mutation 收据", async () => {
    const escrow = {
      projectId,
      machineId,
      escrowId: "les_00000000",
      state: "escrowed" as const,
      chatId: "cnv_00000000",
      targetAgentProfileId: null,
      escrowedByInstanceId: instanceId,
      escrowedAt: time,
      escrowGeneration: 2,
      claimedByInstanceId: null,
      claimedAt: null,
      claimedGeneration: null,
      // I-P8b：超时事实是挂靠视图的必填部分，具体数值不是本用例的关注点。
      timeout: {
        deadlineAt: time,
        notifiedAt: null,
        escalatedAt: null,
        awaitingHandling: false,
        ownerAutoAttemptsPaused: false,
      },
    };
    const lease = {
      ...free,
      generation: 2,
      state: "held" as const,
      holderInstanceId: instanceId,
      escrow,
    };
    let reply: { lease: typeof lease; escrow: typeof escrow } = { lease, escrow };
    const http = await service((_req, res) => {
      res.end(JSON.stringify({ ok: true, requestId, data: reply }));
    });
    try {
      const tool = tools(createRemoteClient(grant(http.endpoint))).get("sprout_lease_escrow")!;
      expect(await tool.execute("probe", cases.sprout_lease_escrow)).toMatchObject({
        isError: false,
        details: {
          outcome: "succeeded",
          data: { lease: { generation: 2 }, escrow: { state: "escrowed" } },
        },
      });
      // 跨 Machine 的挂靠收据不可冒充本次结果。
      reply = { lease, escrow: { ...escrow, machineId: "mch_11111111" } };
      expect(await tool.execute("probe", cases.sprout_lease_escrow)).toMatchObject({
        isError: true,
        details: { outcome: "unknown" },
      });
    } finally {
      http.close();
    }
  });

  it("取消与日志：送达不等于已停止，不完整日志不当空，跨执行响应不可冒充", async () => {
    const cancellation = (
      state: ExecutionCancellationView["state"],
      overrides: Partial<ExecutionCancellationView> = {},
    ): ExecutionCancellationView => ({
      projectId,
      machineId,
      cancelId: "cnl_00000000",
      executionId,
      state,
      requestedAt: time,
      deliveredAt: state === "requested" ? null : time,
      exitedAt: state === "exited_observed" ? time : null,
      signalOutcome: state === "requested" ? "none" : "kill_delivered",
      failureReason: null,
      ...overrides,
    });
    const logRead = (
      logState: ExecutionLogReadView["logState"],
      overrides: Partial<ExecutionLogReadView> = {},
    ): ExecutionLogReadView => ({
      projectId,
      machineId,
      executionId,
      frames: [],
      nextCursor: { executionId, nextSequence: 1 },
      availableFromSequence: null,
      acknowledgedThroughSequence: null,
      producedThroughSequence: null,
      gapRanges: [],
      logState,
      hasMore: false,
      workerOnline: true,
      ...overrides,
    });
    let response: RemoteToolResponse = {
      outcome: "response",
      result: { ok: true, requestId, data: cancellation("delivered") },
    };
    const registered = tools({ projectId, request: async () => response });
    const cancel = registered.get("sprout_remote_execution_cancel")!;
    // 送达不是已停：不算错，但 stopped 必须为 false，文案必须区分。
    const delivered = await cancel.execute("probe", cases.sprout_remote_execution_cancel);
    expect(delivered).toMatchObject({
      isError: false,
      details: { outcome: "delivered", stopped: false },
    });
    expect(String(delivered.details.message)).toContain("不表示进程已停");
    for (const state of ["failed", "unknown"] as const) {
      response = {
        outcome: "response",
        result: { ok: true, requestId, data: cancellation(state) },
      };
      const failed = await cancel.execute("probe", cases.sprout_remote_execution_cancel);
      expect(failed).toMatchObject({ isError: true, details: { outcome: state, stopped: false } });
    }
    response = {
      outcome: "response",
      result: { ok: true, requestId, data: cancellation("exited_observed") },
    };
    expect(await cancel.execute("probe", cases.sprout_remote_execution_cancel)).toMatchObject({
      isError: false,
      details: { outcome: "exited_observed", stopped: true },
    });
    // 跨执行响应不可信。
    response = {
      outcome: "response",
      result: {
        ok: true,
        requestId,
        data: cancellation("exited_observed", {
          executionId: "exe_11111111",
        }),
      },
    };
    expect(await cancel.execute("probe", cases.sprout_remote_execution_cancel)).toMatchObject({
      isError: true,
      details: { outcome: "unknown" },
    });
    const read = registered.get("sprout_remote_execution_log")!;
    for (const [logState, incomplete] of [
      ["gap", true],
      ["truncated", true],
      ["partial", true],
      ["none", false],
      ["full", false],
    ] as const) {
      response = {
        outcome: "response",
        result: { ok: true, requestId, data: logRead(logState) },
      };
      const result = await read.execute("probe", cases.sprout_remote_execution_log);
      expect(result).toMatchObject({
        isError: false,
        details: { logState, incomplete, outcome: incomplete ? "incomplete" : "succeeded" },
      });
    }
    response = {
      outcome: "response",
      result: {
        ok: true,
        requestId,
        data: logRead("full", { executionId: "exe_11111111" }),
      },
    };
    expect(await read.execute("probe", cases.sprout_remote_execution_log)).toMatchObject({
      isError: true,
      details: { outcome: "unknown", reason: "invalid_response" },
    });
  });

  it("宿主 sprout_status 与 sprout-status 仍返回同一原始状态", async () => {
    const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
    const commands = new Map<string, Parameters<SproutExtensionAPI["registerCommand"]>[1]>();
    sproutExtension({
      registerTool: (tool) => {
        registered.set(tool.name, tool);
      },
      registerCommand: (name, command) => {
        commands.set(name, command);
      },
    });
    expect([...registered.keys()]).toEqual(["sprout_status"]);
    const result = await registered.get("sprout_status")!.execute("probe", {});
    expect(result.details).toMatchObject({
      app: "sprout-mio",
      // 进程与会话事实不再报「未实现」：独立 CLI 装载时 pid 就是当前进程，
      // 装载方式是独立 CLI，会话身份由 Pi 自己写（这里没有 Pi 上下文，所以为 null）。
      worker: { pid: process.pid, loader: "standalone-cli" },
      piSession: { host: "none", id: null, file: null },
    });
    let notification = "";
    await commands.get("sprout-status")!.handler("", {
      ui: {
        notify: (message) => {
          notification = message;
        },
      },
    });
    expect(JSON.parse(notification)).toEqual(result.details);
    // sprout_status 的结果按定义是单个 text 块；先断言块类型，再读它的 JSON。
    const [block] = result.content;
    expect(block.type).toBe("text");
    expect(JSON.parse((block as { type: "text"; text: string }).text)).toEqual(result.details);
  });
});

async function service(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}/api/remote/agent`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
function grant(endpoint: string): RemoteToolGrant {
  return { endpoint, secret: "a".repeat(43), projectId, expiresAt: "2026-10-24T00:15:00.000Z" };
}
const read: RemoteAgentRequest = {
  version: 2,
  call: { type: "lease_get", input: { projectId, machineId } },
};

describe("真实 HTTP transport", () => {
  it("只在 Header 传 grant，body 使用宿主 Project，回环不走代理且不带 Origin/Cookie", async () => {
    let identity = false;
    const http = await service((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        identity =
          req.headers.authorization === `Bearer ${"a".repeat(43)}` &&
          !req.headers.cookie &&
          !req.headers.origin &&
          body === JSON.stringify(read) &&
          !body.includes("secret");
        res.end(JSON.stringify({ ok: true, requestId, data: { lease: free, mutation: null } }));
      });
    });
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    try {
      const client = createRemoteClient(grant(http.endpoint));
      const tool = tools(client).get("sprout_lease_get")!;
      expect(await tool.execute("probe", { machineId })).toMatchObject({
        isError: false,
        details: { outcome: "succeeded", data: { lease: free } },
      });
      expect(identity).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previous;
      http.close();
    }
  });

  it("assistant watch stop accepts only an inactive response bound to this target and rejects stop/start shape confusion", async () => {
    const stopped = {
      action: "stopped",
      active: false,
      targetProjectId: projectId,
      chatId: "cnv_11111111",
    };
    let data: unknown = stopped;
    const http = await service((_req, res) =>
      res.end(JSON.stringify({ ok: true, data, requestId })),
    );
    try {
      const client = createRemoteClient(grant(http.endpoint));
      const input = {
        projectId,
        targetProjectId: projectId,
        chatId: stopped.chatId,
        active: false,
      };
      const request: RemoteAgentRequest = { version: 2, call: { type: "assistant_watch", input } };
      expect(await client.request(request)).toMatchObject({
        outcome: "response",
        result: { ok: true, data: stopped },
      });
      for (data of [
        { ...stopped, active: true },
        { ...stopped, chatId: "cnv_22222222" },
        { ...stopped, targetProjectId: "prj_22222222" },
        { active: false, eventId: "msg_11111111", intervalSeconds: 60 },
        { ...stopped, eventId: "unexpected" },
      ])
        expect(await client.request(request)).toEqual({
          outcome: "unknown",
          reason: "invalid_response",
        });
      data = stopped;
      expect(
        await client.request({
          version: 2,
          call: { type: "assistant_watch", input: { ...input, active: true } },
        }),
      ).toEqual({ outcome: "unknown", reason: "invalid_response" });
      data = { active: false, eventId: "msg_11111111", intervalSeconds: 60 };
      expect(
        await client.request({
          version: 2,
          call: {
            type: "assistant_watch",
            input: { ...input, active: undefined, intervalSeconds: 60 },
          },
        }),
      ).toMatchObject({ outcome: "response", result: { ok: true, data } });
    } finally {
      http.close();
    }
  });

  it("assistant observe validates its own successful envelope instead of execution/lease shapes", async () => {
    let data: unknown = { projects: [{ id: projectId, name: "Visible Project" }] };
    const http = await service((_req, res) =>
      res.end(JSON.stringify({ ok: true, data, requestId })),
    );
    try {
      const client = createRemoteClient(grant(http.endpoint));
      const call = {
        type: "assistant_observe" as const,
        input: { projectId, offset: 0, limit: 20 },
      };
      expect(await client.request({ version: 2, call })).toMatchObject({
        outcome: "response",
        result: { ok: true, data },
      });
      for (data of [
        { projects: "corrupt" },
        { agents: [], chats: [] },
        { projects: Array.from({ length: 21 }, () => ({ id: projectId, name: "Visible" })) },
      ]) {
        expect(await client.request({ version: 2, call })).toMatchObject({
          outcome: "unknown",
          reason: "invalid_response",
        });
      }
      data = {
        run: {
          id: "run_11111111",
          status: "completed",
          queuedAt: time,
          startedAt: time,
          settledAt: time,
          errorCode: null,
          errorMessage: null,
          assistantMessageId: null,
        },
        activity: null,
        basis: "settled",
      };
      expect(
        await client.request({
          version: 2,
          call: {
            ...call,
            input: {
              ...call.input,
              targetProjectId: projectId,
              chatId: "cnv_00000000",
              runId: "run_00000000",
            },
          },
        }),
      ).toMatchObject({ outcome: "unknown", reason: "invalid_response" });
    } finally {
      http.close();
    }
  });

  it("assistant proposal success must describe the requested operation", async () => {
    const target = { projectId, kind: "dm_agent" as const, agentProfileId: "agp_00000000" };
    const data = {
      proposalId: "proposal_1",
      status: "pending",
      target: { ...target, chatId: "cnv_00000000" },
      agentProfileId: target.agentProfileId,
      body: "Say hi",
    };
    const http = await service((_req, res) =>
      res.end(JSON.stringify({ ok: true, data, requestId })),
    );
    try {
      const client = createRemoteClient(grant(http.endpoint));
      const request = {
        version: 2 as const,
        call: { type: "assistant_propose" as const, input: { projectId, target, body: "Say hi" } },
      };
      expect(await client.request(request)).toMatchObject({
        outcome: "response",
        result: { ok: true },
      });
      data.body = "Different work";
      expect(await client.request(request)).toMatchObject({
        outcome: "unknown",
        reason: "invalid_response",
      });
      data.body = "Say hi";
      data.target.agentProfileId = "agp_11111111";
      expect(await client.request(request)).toMatchObject({
        outcome: "unknown",
        reason: "invalid_response",
      });
    } finally {
      http.close();
    }
  });

  it("HTTP 200 的领域失败与 HTTP 401 的撤销都不会包装成成功", async () => {
    let status = 200;
    const http = await service((_req, res) => {
      res.statusCode = status;
      res.end(JSON.stringify(denied.outcome === "response" ? denied.result : null));
    });
    try {
      const tool = tools(createRemoteClient(grant(http.endpoint))).get("sprout_lease_get")!;
      for (status of [200, 401])
        expect(await tool.execute("probe", { machineId })).toMatchObject({
          isError: true,
          details: { outcome: "failed" },
        });
    } finally {
      http.close();
    }
  });

  it("真实 HTTP 执行超时保持 timed_out，其他 execution 的响应不可冒充本次结果", async () => {
    const data = {
      projectId,
      machineId,
      executionId,
      requestId,
      authorizationGeneration: 1,
      holderInstanceId: instanceId,
      authority: "holder",
      currentAuthorizationGeneration: 1,
      runId: "run_00000000",
      chatId: "cnv_00000000",
      operation: { kind: "shell", command: "true", waitMs: 0 },
      state: "timed_out",
      createdAt: time,
      dispatchDeadlineAt: "2026-10-24T00:01:00.000Z",
      runtimeDeadlineAt: null,
      maxRuntimeMs: null,
      dispatchConnectionGeneration: null,
      dispatchSeq: null,
      dispatchedAt: null,
      drainedAt: null,
      payloadHash: "a".repeat(64),
      terminalAt: "2026-10-24T00:01:00.000Z",
      failureReason: "deadline",
      recoveryReason: null,
      result: { kind: "shell", failureReason: "deadline" },
      logState: "none" as const,
      producedThroughSequence: null,
      acknowledgedThroughSequence: null,
      availableFromSequence: null,
      cancellation: null,
    };
    const http = await service((_req, res) =>
      res.end(JSON.stringify({ ok: true, requestId, data })),
    );
    try {
      const tool = tools(createRemoteClient(grant(http.endpoint))).get(
        "sprout_remote_execution_get",
      )!;
      expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
        isError: true,
        details: { outcome: "timed_out" },
      });
      data.executionId = "exe_11111111";
      expect(await tool.execute("probe", { machineId, executionId })).toMatchObject({
        isError: true,
        details: { outcome: "unknown", reason: "invalid_response" },
      });
    } finally {
      http.close();
    }
  });

  it("断联、调用方中止与等待超时均为未知，客户端不重试", async () => {
    let count = 0;
    let disconnect = false;
    const http = await service((req) => {
      count += 1;
      if (disconnect) req.socket.destroy();
    });
    try {
      const client = createRemoteClient(grant(http.endpoint), { timeoutMs: 100 });
      expect(await client.request(read)).toEqual({
        outcome: "unknown",
        reason: "transport_timeout",
      });
      expect(count).toBe(1);
      const controller = new AbortController();
      controller.abort();
      expect(await client.request(read, controller.signal)).toEqual({
        outcome: "unknown",
        reason: "cancelled",
      });
      expect(count).toBe(1);
      disconnect = true;
      expect(await client.request(read)).toEqual({ outcome: "unknown", reason: "transport_error" });
      expect(count).toBe(2);
    } finally {
      http.close();
    }
  });

  it("重定向不转发 grant，畸形/超大/跨 Project 响应不会成为可信结果", async () => {
    let mode = "redirect";
    let redirected = 0;
    const target = await service((_req, res) => {
      redirected += 1;
      res.end();
    });
    const http = await service((_req, res) => {
      if (mode === "redirect") {
        res.statusCode = 307;
        res.setHeader("location", target.endpoint);
        res.end();
      } else if (mode === "oversized") res.end("x".repeat(512 * 1024 + 1));
      else if (mode === "other-project")
        res.end(
          JSON.stringify({
            ok: true,
            requestId,
            data: {
              lease: { ...free, projectId: "prj_11111111" },
              mutation: null,
            },
          }),
        );
      else res.end("invalid JSON");
    });
    try {
      const client = createRemoteClient(grant(http.endpoint));
      for (mode of ["redirect", "oversized", "other-project", "malformed"])
        expect(await client.request(read)).toMatchObject({
          outcome: "unknown",
          reason: "invalid_response",
        });
      expect(redirected).toBe(0);
    } finally {
      http.close();
      target.close();
    }
  });
});

// I-P8b：真正走工具调用路径的阻塞式等待（不是只跑域层单测）。
const holderInstanceId = "ins_11111111";
const freeLease: LeaseView = {
  projectId,
  machineId,
  generation: 0,
  state: "free",
  holderInstanceId: null,
  changedAt: time,
  pendingMutationId: null,
  escrow: null,
};
const escrowedLease: LeaseView = {
  projectId,
  machineId,
  generation: 1,
  state: "held",
  holderInstanceId,
  changedAt: time,
  pendingMutationId: null,
  escrow: {
    projectId,
    machineId,
    escrowId: "les_00000000",
    state: "escrowed",
    chatId: "cnv_00000000",
    targetAgentProfileId: null,
    escrowedByInstanceId: holderInstanceId,
    escrowedAt: time,
    escrowGeneration: 1,
    claimedByInstanceId: null,
    claimedAt: null,
    claimedGeneration: null,
    timeout: {
      deadlineAt: time,
      notifiedAt: null,
      escalatedAt: null,
      awaitingHandling: false,
      ownerAutoAttemptsPaused: false,
    },
  },
};
const leaseResponse = (lease: LeaseView): RemoteToolResponse => ({
  outcome: "response",
  result: { ok: true, data: { lease, mutation: null }, requestId },
});

describe("阻塞式等待工具（sprout_lease_wait）", () => {
  const waitTool = (client: RemoteToolClient) => tools(client).get("sprout_lease_wait")!;

  it("空闲时立即成功，且只发 lease_get", async () => {
    const requests: RemoteAgentRequest[] = [];
    const tool = waitTool({
      projectId,
      instanceId,
      request: async (request) => {
        requests.push(request);
        return leaseResponse(freeLease);
      },
    });
    const result = await tool.execute("probe", { machineId });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ outcome: "succeeded" });
    expect(requests.map(({ call }) => call.type)).toEqual(["lease_get"]);
  });

  it("被其他分身持有：到点返回失败加原因，全程只读、绝不抢占或释放", async () => {
    const requests: RemoteAgentRequest[] = [];
    const tool = waitTool({
      projectId,
      instanceId,
      request: async (request) => {
        requests.push(request);
        return leaseResponse(escrowedLease);
      },
    });
    const started = Date.now();
    const result = await tool.execute("probe", { machineId, waitMs: 1_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      outcome: "timed_out",
      reason: "timed_out",
      requestedMs: 1_000,
    });
    expect(JSON.stringify(result.details)).toContain("自行决定");
    // 等待期间只读：永远不会出现会改变归属或向持有者发请求的调用。
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(({ call }) => call.type === "lease_get")).toBe(true);
  });

  it("同一身份并发等待得到 identity_busy，结束后锁会释放", async () => {
    let view: LeaseView = escrowedLease;
    const tool = waitTool({ projectId, instanceId, request: async () => leaseResponse(view) });
    const first = tool.execute("probe", { machineId, waitMs: 1_000 });
    // 第一处等待的下一轮会读到空闲，避免测试再多等一秒。
    view = freeLease;
    const second = await tool.execute("probe", { machineId });
    expect(second.isError).toBe(true);
    expect(second.details).toMatchObject({ outcome: "identity_busy", reason: "identity_busy" });
    expect(await first).toMatchObject({ isError: false });
    const third = await tool.execute("probe", { machineId });
    expect(third.isError).toBe(false);
    expect(third.details).toMatchObject({ outcome: "succeeded" });
  });

  it("读租约失败原样映射，不伪装成等待结果", async () => {
    const tool = waitTool({
      projectId,
      instanceId,
      request: async () => ({ outcome: "unknown", reason: "transport_error" }),
    });
    const result = await tool.execute("probe", { machineId, waitMs: 30_000 });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ outcome: "unknown", reason: "transport_error" });
  });
});
