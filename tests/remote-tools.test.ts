import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { remoteToolInputSchemas } from "../src/contracts/remote";
import type { ExecutionCancellationView, ExecutionLogReadView } from "../src/contracts/remote";
import { createRemoteClient } from "../src/extension/remote-client";
import { registerRemoteTools } from "../src/extension/remote-tools";
import sproutExtension from "../src/extension/main";
import type { RemoteAgentRequest, RemoteToolGrant } from "../src/contracts/remote";
import type { RemoteToolClient, RemoteToolResponse } from "../src/extension/remote-client";
import type { SproutExtensionAPI } from "../src/extension/types";

const projectId = "prj_00000000-0000-4000-8000-000000000000";
const machineId = "mch_00000000-0000-4000-8000-000000000000";
const requestId = "req_00000000-0000-4000-8000-000000000000";
const instanceId = "ins_00000000-0000-4000-8000-000000000000";
const executionId = "exe_00000000-0000-4000-8000-000000000000";
const time = "2026-10-24T00:00:00.000Z";
const free = {
  projectId,
  machineId,
  generation: 0,
  state: "free",
  holderInstanceId: null,
  changedAt: time,
  pendingMutationId: null,
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
  sprout_remote_shell: { ...base, command: "true" },
  sprout_remote_file_read: { ...base, path: "/tmp/file" },
  sprout_remote_file_write: { ...base, path: "/tmp/file", content: "fixture" },
  sprout_remote_process_list: base,
  sprout_remote_process_signal: { ...base, pid: 1234, signal: "TERM" },
  sprout_remote_execution_get: { machineId, executionId },
  sprout_remote_execution_cancel: { ...base, executionId },
  sprout_remote_execution_log: { machineId, executionId, cursor: null },
};

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
        { ...parameters, projectId: "prj_11111111-1111-4111-8111-111111111111" },
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
      ...Array(5).fill("execution_submit"),
      "execution_get",
      "execution_cancel",
      "execution_log_read",
    ]);
    const shell = requests[4]!.call;
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
            runId: "run_00000000-0000-4000-8000-000000000000",
            chatId: "cnv_00000000-0000-4000-8000-000000000000",
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
      mutationId: "lmu_00000000-0000-4000-8000-000000000000",
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

  it("取消与日志：送达不等于已停止，不完整日志不当空，跨执行响应不可冒充", async () => {
    const cancellation = (
      state: ExecutionCancellationView["state"],
      overrides: Partial<ExecutionCancellationView> = {},
    ): ExecutionCancellationView => ({
      projectId,
      machineId,
      cancelId: "cnl_00000000-0000-4000-8000-000000000000",
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
          executionId: "exe_11111111-1111-4111-8111-111111111111",
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
        data: logRead("full", { executionId: "exe_11111111-1111-4111-8111-111111111111" }),
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
      runId: "run_00000000-0000-4000-8000-000000000000",
      chatId: "cnv_00000000-0000-4000-8000-000000000000",
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
      data.executionId = "exe_11111111-1111-4111-8111-111111111111";
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
              lease: { ...free, projectId: "prj_11111111-1111-4111-8111-111111111111" },
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
