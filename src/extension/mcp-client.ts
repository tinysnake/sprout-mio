import type { McpCatalogView } from "../contracts/mcp";
import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import { SproutRelayTransport } from "./mcp-transport";
import type { SproutRelayBinding } from "./mcp-transport";
import type { McpClient, McpTool, PiMcpModule } from "./mcp-pi-types";

export type McpRegistration = McpCatalogView["registrations"][number];
export type McpProcessIdentity = McpRegistration["processes"][number];

export interface SproutMcpHandlers {
  /** 固定合成 fixture 的采样处理器（decisions.tsv 的 r1-sampling 条目）。 */
  sampling?: (params: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
  /** 本轮 UI 不在范围，一律 `{ action: "cancel" }`。 */
  elicitation?: (params: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
}

export interface SproutMcpBinding {
  registration: McpRegistration;
  process: McpProcessIdentity;
  authorizationGeneration: number;
  handlers?: SproutMcpHandlers;
  holdMs?: number;
  stillAllowed?: () => Promise<boolean>;
}

export interface SproutMcpConnection {
  registration: McpRegistration;
  transport: SproutRelayTransport;
  client: McpClient;
  tools: McpTool[];
  close(): Promise<void>;
}

/** 采样 handler 的固定合成响应：只证明协议往返，不是真实模型采样。 */
export const SAMPLING_FIXTURE = Object.freeze({
  role: "assistant",
  content: { type: "text", text: "sprout-sampling-fixture" },
  model: "sprout-fixture",
  stopReason: "endTurn",
});
export const ELICITATION_CANCEL = Object.freeze({ action: "cancel" });

export function relayBinding(
  remote: RemoteToolClient,
  binding: SproutMcpBinding,
): SproutRelayBinding {
  const { registration, process } = binding;
  return {
    remote,
    machineId: registration.machineId,
    authorizationGeneration: binding.authorizationGeneration,
    registrationId: registration.registrationId,
    registrationRevision: registration.registrationRevision,
    processId: process.processId,
    expectedWorkerIncarnationId: process.workerIncarnationId,
    requestTimeoutMs: registration.requestTimeoutMs,
    ...(binding.holdMs === undefined ? {} : { holdMs: binding.holdMs }),
  };
}

/**
 * 建一个 Pi 原生 MCP 客户端，transport 是 Sprout 中继。
 *
 * 顺序在这里是设计要点，不能重排：
 *   1. `new McpClient(...)`（capabilities 里只宣告真装了 handler 的 sampling/elicitation）
 *   2. `setRequestHandler("roots/list" | "sampling/createMessage" | "elicitation/create")`
 *   3. `await client.connect(transport)` —— `initialize` 此刻才发
 *
 * 只有先装 handler 再 connect，`initialize` 的 capabilities 才带得上 sampling，服务端
 * 才会在握手后向我们发起反向请求。`McpClient.connect()` 会读 `options.capabilities` 组装
 * `initialize` 参数（pi-mcp `client.js:125-138`），装晚了那一轮就没有宣告，而
 * `createMcpExtension` 既不暴露 client 也不给 transport 工厂注入点，所以这里必须自己
 * `new McpClient`。改动顺序会静默丢掉反向请求能力，请勿「顺手重排」。
 */
export async function connectSproutMcp(
  piMcp: PiMcpModule,
  remote: RemoteToolClient,
  binding: SproutMcpBinding,
): Promise<SproutMcpConnection> {
  const { registration } = binding;
  const wantsSampling = registration.exposeSampling && binding.handlers?.sampling !== undefined;
  // `elicitation: "cancel"` 才宣告 elicitation；`absent` 一律不宣告。
  const wantsElicitation =
    registration.elicitation === "cancel" && binding.handlers?.elicitation !== undefined;
  const roots = registration.roots.map((root) => ({
    uri: root.uri,
    ...(root.name ? { name: root.name } : {}),
  }));
  const client = new piMcp.McpClient({
    name: "sprout",
    version: "r1",
    requestTimeoutMs: registration.requestTimeoutMs,
    roots,
    capabilities: {
      roots: { listChanged: true },
      ...(wantsSampling ? { sampling: {} } : {}),
      ...(wantsElicitation ? { elicitation: {} } : {}),
    },
  });
  client.setRequestHandler("roots/list", () => ({ roots }));
  if (wantsSampling)
    client.setRequestHandler("sampling/createMessage", (params, context) =>
      binding.handlers!.sampling!(params, context),
    );
  if (wantsElicitation)
    client.setRequestHandler("elicitation/create", (params, context) =>
      binding.handlers!.elicitation!(params, context),
    );
  const transport = new SproutRelayTransport(relayBinding(remote, binding));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return {
      registration,
      transport,
      client,
      tools,
      async close() {
        await client.close();
        await transport.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }
}

/**
 * `mcp_catalog_get`：只取显式登记的 server 摘要，绝不扫描宿主 `~/.pi/agent/mcp.json`。
 * 返回的每条登记都带当前新鲜、未被消费的 process identity。
 */
export async function catalog(
  remote: RemoteToolClient,
  machineId: string,
  authorizationGeneration: number,
): Promise<McpCatalogView> {
  const request = remoteAgentRequestSchema.parse({
    version: 2,
    call: {
      type: "mcp_catalog_get",
      input: { projectId: remote.projectId, machineId, authorizationGeneration },
    },
  });
  const response: RemoteToolResponse = await remote.request(request);
  if (response.outcome !== "response")
    throw new Error(`Sprout 目录查询结果未知：${response.reason}`);
  if (!response.result.ok) throw new Error(`Sprout 拒绝目录查询：${response.result.error.code}`);
  return response.result.data as McpCatalogView;
}
