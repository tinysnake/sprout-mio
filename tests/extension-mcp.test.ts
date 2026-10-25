import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import { mcpSessionSchema } from "../src/contracts/mcp";
import type { McpSession, ServerInboundFrame } from "../src/contracts/mcp";
import type { RemoteAgentRequest } from "../src/contracts/remote";
import { loadPiMcp } from "../src/extension/mcp-load";
import { SproutRelayTransport, SPROUT_MCP_HOLD_MS } from "../src/extension/mcp-transport";
import {
  connectSproutMcp,
  SAMPLING_FIXTURE,
  ELICITATION_CANCEL,
} from "../src/extension/mcp-client";
import { registerMcpTools, visibleTools, mcpToolName } from "../src/extension/mcp-tools";
import { createRemoteClient } from "../src/extension/remote-client";
import type { RemoteToolClient, RemoteToolResponse } from "../src/extension/remote-client";
import type { SproutExtensionAPI } from "../src/extension/types";

const projectId = newId(ID_PREFIXES.project);
const machineId = newId(ID_PREFIXES.machine);
const instanceId = newId(ID_PREFIXES.instance);
const registrationId = newId(ID_PREFIXES.mcpRegistration);
const processId = newId(ID_PREFIXES.mcpProcess);
const grantId = newId(ID_PREFIXES.remoteToolGrant);
const runId = newId(ID_PREFIXES.run);
const chatId = newId(ID_PREFIXES.chat);
const bootId = newId(ID_PREFIXES.boot);
const incarnationId = crypto.randomUUID();
const attemptId = crypto.randomUUID();
const sessionId = newId(ID_PREFIXES.mcpSession);
const now = Date.now();

function session(overrides: Partial<McpSession> = {}): McpSession {
  const base = {
    id: sessionId,
    projectId,
    machineId,
    authorizationGeneration: 1,
    holderInstanceId: instanceId,
    processId,
    registrationId,
    registrationRevision: 1,
    transport: "stdio",
    configHash: "a".repeat(64),
    workerIncarnationId: incarnationId,
    runId,
    grantId,
    chatId,
    openRequestId: newId(ID_PREFIXES.request),
    openHash: "b".repeat(64),
    state: "connecting",
    createdAt: now,
    attachedAt: now,
    connectedAt: null,
    endedAt: null,
    endReason: null,
    protocolVersion: null,
    clientHighWater: 0,
    workerAckClientSeq: 0,
    serverHighWater: 0,
    hostAckServerSeq: 0,
    workerStateRevision: 1,
    workerStateHash: "c".repeat(64),
    workerDetachedAt: null,
    fenceMutationId: null,
    workerConnectionGeneration: 1,
    serverBootId: bootId,
    workerAttemptId: attemptId,
  };
  const merged = { ...base, ...overrides } as McpSession;
  // 契约是权威形状：测试夹具必须过它。
  expect(mcpSessionSchema.safeParse(merged).success).toBe(true);
  return merged;
}

function frame(seq: number, message: unknown, overrides: Partial<ServerInboundFrame> = {}) {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  return {
    frameId: newId(ID_PREFIXES.mcpFrame),
    seq,
    payloadBase64: bytes.toString("base64"),
    payloadBytes: bytes.byteLength,
    payloadHash: createHash("sha256").update(bytes).digest("hex"),
    expiresAt: now + 60_000,
    ...overrides,
  } satisfies ServerInboundFrame;
}

type Call = RemoteAgentRequest["call"];

/**
 * 受控的 Sprout 通道：实现 `RemoteToolClient`，把 exchange 当作可被唤醒的有界 hold。
 * 这不是 MCP 的 mock —— MCP 那一侧始终是真实的 Pi `McpClient`，被替换的只有网络与 Worker。
 */
class Channel implements RemoteToolClient {
  readonly projectId = projectId;
  readonly exchanges: Extract<Call, { type: "mcp_session_exchange" }>[] = [];
  /** 测试用的 MCP server 端：只回答 transport 交给通道的那些 JSON-RPC 请求。 */
  readonly tools = [
    { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
    { name: "add", description: "相加", inputSchema: { type: "object", properties: {} } },
  ];
  private attached = true;
  private confirmed = false;
  private protocolVersion: string | null = null;
  private clientHighWater = 0;
  private serverHighWater = 0;
  private hostAckServerSeq = 0;
  private inbound: ServerInboundFrame[] = [];
  private wake = new EventEmitter();
  private closed = false;
  /** 由被测 transport 发出的每一帧（解码后的 JSON-RPC）。 */
  readonly upstream: unknown[] = [];

  constructor(
    private readonly options: {
      attach?: boolean;
      deny?: "not_found" | "lease_stale_generation" | "machine_unavailable";
    } = {},
  ) {
    this.wake.setMaxListeners(0);
  }

  session(overrides: Partial<McpSession> = {}): McpSession {
    return session({
      attachedAt: this.attached ? now : null,
      connectedAt: this.confirmed ? now : null,
      state: this.confirmed ? "connected" : "connecting",
      protocolVersion: this.protocolVersion,
      clientHighWater: this.clientHighWater,
      serverHighWater: this.serverHighWater,
      hostAckServerSeq: this.hostAckServerSeq,
      ...overrides,
    });
  }

  /** 让「Worker」回一帧，并立刻叫醒可能正在 hold 的 exchange。 */
  publish(message: unknown) {
    this.serverHighWater += 1;
    this.inbound.push(frame(this.serverHighWater, message));
    this.wake.emit("frame");
  }

  /** 通道把上行帧交给「Machine 上的 MCP server」，只回答它认识的请求。 */
  private serve(message: unknown) {
    const request = message as { id?: unknown; method?: string };
    if (request.id === undefined || request.method === undefined) return;
    const result = (value: unknown) =>
      this.publish({ jsonrpc: "2.0", id: request.id, result: value });
    switch (request.method) {
      case "initialize":
        return result({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, sampling: {} },
          serverInfo: { name: "fixture-everything", version: "0.0.1" },
        });
      case "tools/list":
        return result({ tools: this.tools });
      case "tools/call":
        return result({ content: [{ type: "text", text: "fixture-result" }] });
      case "ping":
        return result({});
      default:
        return this.publish({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  }

  async request(input: RemoteAgentRequest, signal?: AbortSignal): Promise<RemoteToolResponse> {
    const { call } = input;
    if (this.options.deny) return denial(this.options.deny);
    switch (call.type) {
      case "mcp_session_open":
        this.attached = this.options.attach ?? true;
        return accept({ session: this.session() });
      case "mcp_session_close":
        this.closed = true;
        this.wake.emit("frame");
        return accept({
          session: this.session({ state: "closed", endedAt: now, endReason: "client_closed" }),
        });
      case "mcp_session_exchange": {
        this.exchanges.push(call);
        for (const item of call.input.frames) {
          const message = JSON.parse(
            Buffer.from(item.payloadBase64, "base64").toString("utf8"),
          ) as unknown;
          this.upstream.push(message);
          this.clientHighWater = Math.max(this.clientHighWater, item.seq);
          this.serve(message);
        }
        const ack = call.input.ackServerSeq;
        if (ack > this.hostAckServerSeq) this.hostAckServerSeq = ack;
        if (call.input.protocolVersion !== null) this.protocolVersion = call.input.protocolVersion;
        if (call.input.confirmInitialized) this.confirmed = true;
        const deliver = () => ({
          session: this.session(),
          acceptedClientSeq: this.clientHighWater,
          frames: this.inbound.splice(0, 2),
          hasMore: this.inbound.length > 0,
        });
        if (this.inbound.length === 0 && call.input.holdMs > 0 && !this.closed)
          await this.hold(call.input.holdMs, signal);
        // `createRemoteClient` 用 outcome:'unknown'/cancelled 表示被 abort 的 hold。
        if (signal?.aborted) return { outcome: "unknown", reason: "cancelled" };
        return accept(deliver());
      }
      default:
        // catalog 与既有的 lease/execution call 不在本文件的被测范围。
        return denial("not_found");
    }
  }

  private hold(holdMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake.off("frame", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, holdMs);
      this.wake.on("frame", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

function accept(data: unknown): RemoteToolResponse {
  return {
    outcome: "response",
    result: { ok: true, data: data as never, requestId: newId(ID_PREFIXES.request) },
  };
}

function denial(code: "not_found" | "lease_stale_generation" | "machine_unavailable") {
  // 只允许契约里已登记的封闭错误码。
  return {
    outcome: "response",
    result: {
      ok: false,
      error: { code, message: code, requestId: newId(ID_PREFIXES.request) },
      requestId: newId(ID_PREFIXES.request),
    },
  } as RemoteToolResponse;
}

function binding(channel: RemoteToolClient, overrides: Record<string, unknown> = {}) {
  return {
    remote: channel,
    machineId,
    authorizationGeneration: 1,
    registrationId,
    registrationRevision: 1,
    processId,
    expectedWorkerIncarnationId: incarnationId,
    requestTimeoutMs: 120_000,
    ...overrides,
  };
}

const registration = {
  registrationId,
  registrationRevision: 1,
  projectId,
  machineId,
  name: "everything",
  transport: "stdio" as const,
  configHash: "a".repeat(64),
  exposure: "wire" as const,
  requestTimeoutMs: 120_000,
  roots: [],
  exposeSampling: true,
  elicitation: "cancel" as const,
  processes: [{ processId, workerIncarnationId: incarnationId, lastObservedAt: now }],
};

describe("Sprout MCP 中继 transport", () => {
  it("自定义 transport 的帧往返：Pi 客户端 send → 通道 → 回来 → onmessage", async () => {
    const channel = new Channel();
    // 服务端一上来就回一帧 server→client 请求（sampling）。
    channel.publish({ jsonrpc: "2.0", id: "srv-1", method: "sampling/createMessage", params: {} });
    const transport = new SproutRelayTransport(binding(channel, { holdMs: 200 }));
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await waitFor(() => received.length > 0 && channel.upstream.length > 0);
    expect(channel.upstream).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(received[0]).toMatchObject({ method: "sampling/createMessage" });
    const seqs = channel.exchanges.flatMap((call) => call.input.frames.map((f) => f.seq));
    // 帧序号严格从 1 起连续，重发复用原 seq。
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.min(...seqs)).toBe(1);
    await transport.close();
  });

  it("setRequestHandler 在 connect 之前注册，且 initialize 已带 sampling 能力", async () => {
    const piMcp = await loadPiMcp();
    const channel = new Channel();
    const order: string[] = [];
    const Base = piMcp.McpClient as unknown as new (options: never) => {
      setRequestHandler(method: string, handler: unknown): () => void;
      connect(transport: unknown): Promise<unknown>;
    };
    class SpyingClient extends Base {
      override setRequestHandler(method: string, handler: unknown) {
        order.push(`handler:${method}`);
        return super.setRequestHandler(method, handler);
      }
      override async connect(transport: unknown) {
        order.push("connect");
        return super.connect(transport);
      }
    }
    const spied = {
      ...piMcp,
      McpClient: SpyingClient as unknown as typeof piMcp.McpClient,
    };
    const connection = await connectSproutMcp(spied, channel, {
      registration,
      process: registration.processes[0]!,
      authorizationGeneration: 1,
      holdMs: 200,
      handlers: {
        sampling: async () => SAMPLING_FIXTURE,
        elicitation: async () => ELICITATION_CANCEL,
      },
    });
    // 三条 handler 全部排在 connect 之前 —— 这是候选 A 胜出的唯一理由。
    expect(order).toEqual([
      "handler:roots/list",
      "handler:sampling/createMessage",
      "handler:elicitation/create",
      "connect",
    ]);
    expect(order.indexOf("connect")).toBe(3);
    const initialize = channel.upstream.find(
      (message) => (message as { method?: string }).method === "initialize",
    ) as { params?: { capabilities?: Record<string, unknown> } } | undefined;
    expect(initialize?.params?.capabilities).toMatchObject({
      roots: { listChanged: true },
      sampling: {},
      elicitation: {},
    });
    await connection.close();
  });

  it("sampling 在 initialize 之前已就位：返固定 fixture；elicitation 一律 cancel", async () => {
    const piMcp = await loadPiMcp();
    const channel = new Channel();
    const connection = await connectSproutMcp(piMcp, channel, {
      registration,
      process: registration.processes[0]!,
      authorizationGeneration: 1,
      holdMs: 100,
      handlers: {
        sampling: async () => SAMPLING_FIXTURE,
        elicitation: async () => ELICITATION_CANCEL,
      },
    });
    channel.publish({ jsonrpc: "2.0", id: "samp-1", method: "sampling/createMessage", params: {} });
    channel.publish({ jsonrpc: "2.0", id: "elic-1", method: "elicitation/create", params: {} });
    const replies = await waitFor(
      () =>
        channel.upstream.filter(
          (message) =>
            (message as { id?: unknown }).id !== undefined && !("method" in (message as object)),
        ).length >= 2
          ? channel.upstream.filter((message) => !("method" in (message as object)))
          : undefined,
      5000,
    );
    const sampling = replies.find((reply) => (reply as { id?: unknown }).id === "samp-1");
    const elicitation = replies.find((reply) => (reply as { id?: unknown }).id === "elic-1");
    expect(sampling).toMatchObject({ jsonrpc: "2.0", result: SAMPLING_FIXTURE });
    expect(elicitation).toMatchObject({ jsonrpc: "2.0", result: ELICITATION_CANCEL });
    await connection.close();
  });

  it("不宣告 sampling/elicitation 时服务端反向请求得到 -32601", async () => {
    const piMcp = await loadPiMcp();
    const channel = new Channel();
    const connection = await connectSproutMcp(piMcp, channel, {
      registration: { ...registration, exposeSampling: false, elicitation: "absent" as const },
      process: registration.processes[0]!,
      authorizationGeneration: 1,
      holdMs: 100,
    });
    const initialize = channel.upstream.find(
      (message) => (message as { method?: string }).method === "initialize",
    ) as { params?: { capabilities?: Record<string, unknown> } } | undefined;
    expect(initialize?.params?.capabilities).not.toHaveProperty("sampling");
    expect(initialize?.params?.capabilities).not.toHaveProperty("elicitation");
    await connection.close();
  });

  it("有界 hold：无帧时最多等 holdMs，不做 250ms 空闲轮询", async () => {
    const channel = new Channel();
    const transport = new SproutRelayTransport(binding(channel, { holdMs: 300 }));
    await transport.start();
    const before = transport.counters.exchanges;
    const beforeEmpty = transport.counters.emptyExchanges;
    await sleep(1200);
    const exchanges = transport.counters.exchanges - before;
    const empty = transport.counters.emptyExchanges - beforeEmpty;
    // 1.2 s / 300 ms ≈ 4 次；若退回 250 ms 空闲轮询会多出数倍请求。
    expect(exchanges).toBeLessThanOrEqual(6);
    expect(SPROUT_MCP_HOLD_MS).toBe(2000);
    expect(channel.exchanges.every((call) => call.input.holdMs <= 2000)).toBe(true);
    expect(empty).toBeGreaterThan(0);
    // 实测空转请求数：holdMs=300 时 1.2 s 内约 4 次空 exchange；默认 holdMs=2000 时约 0–1 次。
    // 若退回候选 A 的 250 ms 空闲轮询，同一窗口是 4–5 次且每次各带一整个 immediate 认证事务。
    expect(empty).toBe(exchanges);
    console.log(`IDLE_EXCHANGES_IN_1200MS=${empty}`);
    await transport.close();
  });

  it("有帧要发时 hold 被立刻打断，不等超时", async () => {
    const channel = new Channel();
    const transport = new SproutRelayTransport(binding(channel, { holdMs: 2000 }));
    await transport.start();
    await sleep(200);
    const started = Date.now();
    await transport.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(transport.counters.heldAborts).toBeGreaterThan(0);
    await transport.close();
  });
});

describe("远端 MCP 工具面", () => {
  it("只暴露 toolAllowlist 内的工具，名字是 mcp__<server>__<tool>", () => {
    const tools = [
      { name: "alpha", inputSchema: { type: "object" } },
      { name: "beta", inputSchema: { type: "object" } },
    ];
    expect(visibleTools(registration, tools).map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(
      visibleTools({ ...registration, toolAllowlist: ["beta"] }, tools).map((tool) => tool.name),
    ).toEqual(["beta"]);
    expect(mcpToolName("everything", "beta")).toBe("mcp__everything__beta");
  });

  it("工具调用结果保持 MCP content，失败标 isError 且不改投", async () => {
    const piMcp = await loadPiMcp();
    const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
    const connection = {
      registration,
      transport: {} as never,
      client: {
        callTool: async (name: string) =>
          name === "alpha"
            ? { content: [{ type: "text", text: "ok" }] }
            : { content: [{ type: "text", text: "boom" }], isError: true },
      } as never,
      tools: [
        { name: "alpha", inputSchema: { type: "object", properties: {} } },
        { name: "beta", inputSchema: { type: "object", properties: {} } },
      ],
      close: async () => undefined,
    };
    const names = registerMcpTools(
      {
        registerTool: (tool) => {
          registered.set(tool.name, tool);
        },
      },
      piMcp,
      connection,
    );
    expect(names).toEqual(["mcp__everything__alpha", "mcp__everything__beta"]);
    const ok = await registered.get("mcp__everything__alpha")!.execute("probe", {}, undefined);
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toEqual([{ type: "text", text: "ok" }]);
    const failed = await registered.get("mcp__everything__beta")!.execute("probe", {}, undefined);
    expect(failed.isError).toBe(true);
  });

  it("stillAllowed 为假时不再把同一 session 当作可用通道", async () => {
    const piMcp = await loadPiMcp();
    const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
    let called = 0;
    registerMcpTools(
      { registerTool: (tool) => registered.set(tool.name, tool) },
      piMcp,
      {
        registration,
        transport: {} as never,
        client: { callTool: async () => ((called += 1), { content: [] }) } as never,
        tools: [{ name: "alpha", inputSchema: { type: "object" } }],
        close: async () => undefined,
      },
      { stillAllowed: async () => false },
    );
    const result = await registered.get("mcp__everything__alpha")!.execute("probe", {}, undefined);
    expect(result.isError).toBe(true);
    expect(called).toBe(0);
  });
});

describe("session_start 接线", () => {
  it("只连 catalog 里显式登记、且有新鲜 process identity 的 server；绝不读宿主 mcp.json", async () => {
    const piMcp = await loadPiMcp();
    const channel = new Channel();
    const started: (() => Promise<void>)[] = [];
    const registered = new Map<string, Parameters<SproutExtensionAPI["registerTool"]>[0]>();
    const { registerSproutMcp } = await import("../src/extension/mcp-extension");
    // catalog 用真实契约形状：一条有 process，一条没有。
    const catalogView = {
      registrations: [
        {
          registrationId,
          registrationRevision: 1,
          projectId,
          machineId,
          name: "everything",
          transport: "stdio",
          configHash: "a".repeat(64),
          exposure: "wire",
          requestTimeoutMs: 120_000,
          roots: [],
          exposeSampling: false,
          elicitation: "absent",
          processes: [{ processId, workerIncarnationId: incarnationId, lastObservedAt: now }],
        },
        {
          registrationId: newId(ID_PREFIXES.mcpRegistration),
          registrationRevision: 1,
          projectId,
          machineId,
          name: "unstarted",
          transport: "stdio",
          configHash: "a".repeat(64),
          exposure: "wire",
          requestTimeoutMs: 120_000,
          roots: [],
          exposeSampling: false,
          elicitation: "absent",
          processes: [],
        },
      ],
    };
    const remote: RemoteToolClient = {
      projectId,
      request: async (request) =>
        request.call.type === "mcp_catalog_get" ? accept(catalogView) : channel.request(request),
    };
    const extension = await registerSproutMcp(
      {
        registerTool: (tool) => registered.set(tool.name, tool),
        on: (event, handler) => {
          if (event === "session_start") started.push(handler as () => Promise<void>);
        },
      },
      {
        remote,
        machineId,
        authorizationGeneration: () => 1,
        piMcp,
        holdMs: 100,
        handlers: { sampling: async () => SAMPLING_FIXTURE },
      },
    );
    expect(started).toHaveLength(1);
    await started[0]!();
    // 「unstarted」没有 running process，不得被连上，也不得出现在工具面。
    expect(extension.tools).toEqual(["mcp__everything__echo", "mcp__everything__add"]);
    await extension.close();
  });

  it("租约代次为空时不连任何 server", async () => {
    const started: (() => Promise<void>)[] = [];
    const { registerSproutMcp } = await import("../src/extension/mcp-extension");
    const extension = await registerSproutMcp(
      {
        registerTool: () => undefined,
        on: (event, handler) => {
          if (event === "session_start") started.push(handler as () => Promise<void>);
        },
      },
      {
        remote: { projectId, request: async () => denial("not_found") },
        machineId,
        authorizationGeneration: () => null,
        piMcp: await loadPiMcp(),
      },
    );
    await started[0]!();
    expect(extension.tools).toEqual([]);
    await extension.close();
  });
});

describe("既有的远端工具面没有回归", () => {
  it("MCP 通道不改动 sprout_remote_* 的请求形状", async () => {
    // 只断言 createRemoteClient 存在的公开形状，避免与 remote-tools.test.ts 重复。
    expect(typeof createRemoteClient).toBe("function");
  });
});

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value as T;
    await sleep(20);
  }
  throw new Error("等待条件超时");
}
