import type { RemoteToolClient } from "./remote-client";
import { catalog, connectSproutMcp } from "./mcp-client";
import type { SproutMcpConnection, SproutMcpHandlers } from "./mcp-client";
import { loadPiMcp } from "./mcp-load";
import { registerMcpTools } from "./mcp-tools";
import type { SproutExtensionAPI } from "./types";
import type { PiMcpModule } from "./mcp-pi-types";

/** 只声明本 extension 需要的 `pi.on` 子集（与 `pi/sprout-extension.ts` 同一用法）。 */
type SessionEvents = {
  on(event: "session_start", handler: () => void | Promise<void>): void;
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
};

export interface SproutMcpExtensionOptions {
  remote: RemoteToolClient;
  /** 显式指定的 Machine；本扩展不选择默认 Machine。 */
  machineId: string;
  /** 当前租约的授权代次；由调用方在拿到租约后传入。 */
  authorizationGeneration: () => number | null;
  handlers?: SproutMcpHandlers;
  /** 只连哪些登记（按 name）；省略表示 catalog 里的全部。 */
  serverNames?: readonly string[];
  holdMs?: number;
  /** 注入用；生产路径走 `loadPiMcp()` 的运行时解析。 */
  piMcp?: PiMcpModule;
  /** 失败上报（默认仅在工具面缺席时静默，不吞掉错误）。 */
  onError?: (error: Error) => void;
}

export interface SproutMcpExtension {
  readonly tools: readonly string[];
  close(): Promise<void>;
}

const live = new WeakMap<object, { connections: SproutMcpConnection[]; tools: string[] }>();

/**
 * 把显式登记的远端 MCP server 装进 Pi 的工具面。
 *
 * 只在 `session_start` 时按 `mcp_catalog_get` 的结果连接 —— 绝不扫描宿主
 * `~/.pi/agent/mcp.json`（standing order 7）。每个登记只用它自己那条 process identity，
 * 目标消失就报错，不改投同名 server。
 *
 * 接线位置：与 `registerRemoteTools(pi, remoteClient)` 并列调用一次即可
 * （`scripts/pi-host-runner.mjs` 的 `extensionFactories` 里）。本单元不改那个文件。
 */
export async function registerSproutMcp(
  pi: Pick<SproutExtensionAPI, "registerTool"> & SessionEvents,
  options: SproutMcpExtensionOptions,
): Promise<SproutMcpExtension> {
  const piMcp = options.piMcp ?? (await loadPiMcp());
  const state = { connections: [] as SproutMcpConnection[], tools: [] as string[] };
  const closeAll = async () => {
    for (const connection of state.connections)
      await connection
        .close()
        .catch((error: unknown) =>
          options.onError?.(error instanceof Error ? error : new Error("MCP 断开失败")),
        );
    state.connections = [];
    state.tools = [];
  };
  pi.on("session_shutdown", closeAll);
  pi.on("session_start", async () => {
    await closeAll();
    const generation = options.authorizationGeneration();
    if (generation === null) return;
    try {
      const view = await catalog(options.remote, options.machineId, generation);
      const wanted = options.serverNames ? new Set(options.serverNames) : null;
      for (const registration of view.registrations) {
        if (wanted && !wanted.has(registration.name)) continue;
        // 一次只认一个 process identity：没有新鲜的 running 进程就不假装能连。
        const identity = registration.processes[0];
        if (!identity) continue;
        const connection = await connectSproutMcp(piMcp, options.remote, {
          registration,
          process: identity,
          authorizationGeneration: generation,
          ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
          ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
        });
        state.connections.push(connection);
        state.tools.push(
          ...registerMcpTools(pi, piMcp, connection, {
            stillAllowed: async () => options.authorizationGeneration() === generation,
          }),
        );
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error("MCP server 连接失败"));
    }
  });
  live.set(pi, state);
  return {
    get tools() {
      return state.tools;
    },
    close: closeAll,
  };
}

/** 当前已装进工具面的 MCP 工具（诊断与验收读取）。 */
export function sproutMcpTools(pi: object): readonly string[] {
  return live.get(pi)?.tools ?? [];
}
