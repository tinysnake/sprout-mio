import type { RemoteToolClient } from "./remote-client";
import { catalog, connectSproutMcp } from "./mcp-client";
import type { McpRegistration, SproutMcpConnection, SproutMcpHandlers } from "./mcp-client";
import { loadPiMcp } from "./mcp-load";
import { registerMcpTools } from "./mcp-tools";
import type { SproutExtensionAPI, ToolSurfaceCheck } from "./types";
import type { PiMcpModule } from "./mcp-pi-types";

/** 只声明本 extension 需要的 `pi.on` 子集（与 `pi/sprout-extension.ts` 同一用法）。 */
type SessionEvents = {
  on(event: "session_start", handler: () => void | Promise<void>): void;
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
};

export interface SproutMcpExtensionOptions {
  remote: RemoteToolClient;
  /** 显式指定的 Machine；本扩展不选择默认 Machine。 */
  machineId: string | (() => string | null);
  /** 当前租约的授权代次；由调用方在拿到租约后传入。 */
  authorizationGeneration: () => number | null;
  handlers?: SproutMcpHandlers;
  /** 只连哪些登记（按 name）；省略表示 catalog 里的全部。 */
  serverNames?: readonly string[];
  holdMs?: number;
  /** 注入用；生产路径走 `loadPiMcp()` 的运行时解析。 */
  piMcp?: PiMcpModule;
  /** 失败上报。默认落到 `sprout_status` 的诊断通道，绝不静默 return ok。 */
  onError?: (error: Error) => void;
}

/** 一次同步的结果。只有「注册成功且真的进了模型工具面」才算 ok。 */
export type SproutMcpRefreshResult =
  | { outcome: "ok"; tools: string[] }
  /** 没有可连的目标（未持租约 / 无 process identity）：不是失败，也不算装载成功。 */
  | { outcome: "idle"; reason: string }
  /** 目录变了但工具面没跟进，或连接/查询失败。 */
  | { outcome: "failed"; error: Error };

export interface SproutMcpExtension {
  readonly tools: readonly string[];
  /** 诊断通道：最后一次失败文本（`sprout_status` 读它）。 */
  readonly lastError: string | null;
  /**
   * 按 catalog 重新对齐连接，并重新读每个连接的 `tools/list`。
   * 与旧实现的区别见 `orchestrate/sprout-mio-r1/reports/remediation-extension.md`：
   * 已对齐的连接**不重连**，所以 server 侧的 `list_changed` 不会被一次重连丢掉。
   */
  refresh(): Promise<SproutMcpRefreshResult>;
  close(): Promise<void>;
}

interface SurfaceState {
  connections: SproutMcpConnection[];
  tools: string[];
  lastError: string | null;
  /** list_changed 的退订函数，与 connections 同生命周期。 */
  unsubscribes: (() => void)[];
}

const live = new WeakMap<object, SurfaceState>();

/**
 * 全局的诊断槽：`sprout_status` 在另一个模块里，读这里。
 *
 * 只存最后一条失败的文本，不存 Error 实例（不泄漏栈、不持有连接）。
 */
const surfaceDiagnostics: { lastError: string | null } = { lastError: null };

/** 当前 MCP 工具面诊断（`sprout_status` 与验收读取）。 */
export function mcpSurfaceDiagnostics(): { lastError: string | null } {
  return { ...surfaceDiagnostics };
}

/**
 * 一条连接与它的 catalog 身份：只有三者都相同才能复用同一条连接。
 * 身份一变就必须换连接——目标消失不得改投别的 process（standing order 6）。
 */
function connectionKey(registration: McpRegistration, processId: string | undefined): string {
  return [registration.registrationId, registration.registrationRevision, processId ?? ""].join(
    "|",
  );
}

/** 工具面外的可见失败文本：点名工具，并说明宿主怎么修。 */
function surfaceError(tools: readonly string[]): Error {
  return new Error(
    `MCP 工具已注册但未进入模型工具面：${tools.join(", ")}。` +
      "Pi 的 tools allowlist 会保留 mcp__ 前缀的工具却不声明给模型" +
      "（这些工具在 registry 里，`getActiveTools()` 里没有）；" +
      "宿主需要在允许名单里加入 `mcp__*`，或让该 session 不传 tools。",
  );
}

/**
 * 把显式登记的远端 MCP server 装进 Pi 的工具面。
 *
 * 在 `session_start` 或显式租约目标更新时按 `mcp_catalog_get` 的结果连接，绝不扫描宿主
 * `~/.pi/agent/mcp.json`（standing order 7）。每个登记只用它自己那条 process identity，
 * 目标消失就报错，不改投同名 server。
 *
 * 接线位置：与 `registerRemoteTools(pi, remoteClient)` 并列调用一次即可
 * （`scripts/pi-host-runner.mjs` 的 `extensionFactories` 里）。
 *
 * 工具面生效链路（B2 根因，证据见 `reports/remediation-extension.md`）有三段，缺一段
 * 就会「注册成功但对模型不可见」：
 *   1. `registerTool` 进 registry —— Pi 1.4.0 运行期允许，且会 `refreshTools()`；
 *   2. 进 active set（= `getActiveTools()`，即声明给模型）—— 受 `createAgentSession({tools})`
 *      的 allowlist 约束：精确名 allowlist 不含 `mcp__` 条目时 Pi 只保留 registry 不声明；
 *   3. server 真的改了目录 —— 必须先订阅 `notifications/tools/list_changed` 再重列，
 *      否则重连会把新工具一起丢掉。
 * 这里对三段都负责：连接复用、`list_changed` 订阅、以及向 Pi 核对第 2 段。
 */
export async function registerSproutMcp(
  pi: Pick<SproutExtensionAPI, "registerTool"> &
    SessionEvents &
    Partial<Pick<SproutExtensionAPI, "getActiveTools">>,
  options: SproutMcpExtensionOptions,
): Promise<SproutMcpExtension> {
  const piMcp = options.piMcp ?? (await loadPiMcp());
  const state: SurfaceState = { connections: [], tools: [], lastError: null, unsubscribes: [] };
  const report = (error: Error) => {
    state.lastError = error.message;
    surfaceDiagnostics.lastError = error.message;
    options.onError?.(error);
  };
  /** 重新收集当前所有连接的已注册工具名，并核对它们是否声明给了模型。 */
  const settle = (): SproutMcpRefreshResult => {
    state.tools = [
      ...new Set(
        state.connections.flatMap((connection) =>
          connection.tools.map((tool) => `mcp__${connection.registration.name}__${tool.name}`),
        ),
      ),
    ];
    const surface = checkSurface(state.tools);
    if (surface.state === "missing") {
      const error = surfaceError(surface.tools);
      report(error);
      return { outcome: "failed", error };
    }
    if (surface.state === "unknown") report(new Error(`MCP 工具面无法核对：${surface.reason}`));
    return { outcome: "ok", tools: state.tools };
  };
  /** 注册成功之后，问 Pi 这些工具是否真的进了模型工具面。 */
  const checkSurface = (names: readonly string[]): ToolSurfaceCheck => {
    if (names.length === 0) return { state: "declared" };
    if (typeof pi.getActiveTools !== "function")
      return { state: "unknown", reason: "Pi extension API 没有提供 getActiveTools" };
    const active = new Set(pi.getActiveTools());
    const missing = names.filter((name) => !active.has(name));
    return missing.length === 0 ? { state: "declared" } : { state: "missing", tools: missing };
  };
  /** 重列一条连接的工具并注册新增项；Pi 的 registerTool 按名字覆盖，重复注册无害。 */
  const syncConnection = async (
    connection: SproutMcpConnection,
    generation: number,
    machineId: string,
  ): Promise<void> => {
    connection.tools = await connection.client.listTools();
    registerMcpTools(pi, piMcp, connection, {
      // 每次调用前复核当前授权是否仍指向同一条连接。
      stillAllowed: async () =>
        options.authorizationGeneration() === generation &&
        (typeof options.machineId === "function" ? options.machineId() : options.machineId) ===
          machineId,
    });
  };
  const closeAll = async () => {
    for (const unsubscribe of state.unsubscribes) unsubscribe();
    state.unsubscribes = [];
    for (const connection of state.connections)
      await connection
        .close()
        .catch((error: unknown) =>
          report(error instanceof Error ? error : new Error("MCP 断开失败")),
        );
    state.connections = [];
    state.tools = [];
  };

  pi.on("session_shutdown", closeAll);
  const refresh = async (): Promise<SproutMcpRefreshResult> => {
    state.lastError = null;
    surfaceDiagnostics.lastError = null;
    const machineId =
      typeof options.machineId === "function" ? options.machineId() : options.machineId;
    const generation = options.authorizationGeneration();
    if (machineId === null || generation === null) {
      await closeAll();
      return { outcome: "idle", reason: "未持有可用的 Machine 租约代次" };
    }
    try {
      const view = await catalog(options.remote, machineId, generation);
      const wanted = options.serverNames ? new Set(options.serverNames) : null;
      const desired = view.registrations.filter(
        (registration) =>
          (!wanted || wanted.has(registration.name)) && registration.processes[0] !== undefined,
      );
      // 复用 key 相同的连接：重连会换 server 会话，把 list_changed 期间新增的工具丢掉。
      const reusable = new Map(
        state.connections.map((connection) => [
          connectionKey(connection.registration, connection.registration.processes[0]?.processId),
          connection,
        ]),
      );
      const kept = new Set<SproutMcpConnection>();
      for (const registration of desired) {
        const identity = registration.processes[0]!;
        const existing = reusable.get(connectionKey(registration, identity.processId));
        if (existing) {
          kept.add(existing);
          existing.registration = registration;
          await syncConnection(existing, generation, machineId);
          continue;
        }
        const connection = await connectSproutMcp(piMcp, options.remote, {
          registration,
          process: identity,
          authorizationGeneration: generation,
          ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
          ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
        });
        await syncConnection(connection, generation, machineId);
        kept.add(connection);
        // 订阅目录变化：只发通知、不重列的 server 也必须在下一轮被看到。
        state.unsubscribes.push(
          connection.client.onNotification("notifications/tools/list_changed", () => {
            void syncConnection(connection, generation, machineId)
              .then(() => {
                settle();
              })
              .catch((error: unknown) =>
                report(error instanceof Error ? error : new Error("MCP 工具目录变化后重列失败")),
              );
          }),
        );
      }
      // 不再指向 catalog 的连接必须断开（目标消失不改投）。
      for (const connection of state.connections)
        if (!kept.has(connection))
          await connection
            .close()
            .catch((error: unknown) =>
              report(error instanceof Error ? error : new Error("MCP 断开失败")),
            );
      state.connections = [...kept];
      return settle();
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error("MCP server 连接失败");
      report(wrapped);
      return { outcome: "failed", error: wrapped };
    }
  };
  pi.on("session_start", async () => {
    await refresh();
  });
  live.set(pi, state);
  return {
    get tools() {
      return state.tools;
    },
    get lastError() {
      return state.lastError;
    },
    refresh,
    close: closeAll,
  };
}

/** 当前已装进工具面的 MCP 工具（诊断与验收读取）。 */
export function sproutMcpTools(pi: object): readonly string[] {
  return live.get(pi)?.tools ?? [];
}

/** 最近一次失败的文本；没有失败返回 null（`sprout_status` 的诊断来源）。 */
export function sproutMcpError(pi: object): string | null {
  return live.get(pi)?.lastError ?? null;
}
