import { APP_VERSION, CONTRACT_VERSION } from "../contracts/version";
import type { SproutExtensionAPI } from "./types";
import { mcpSurfaceDiagnostics } from "./mcp-extension";

/**
 * `sprout_status` 的载荷：版本 + 未实现边界 + 诊断槽。
 *
 * 这三个字段是 P1 的边界声明，`a-base.sh` 用 `deepEqual` 钉住了它们的完整形状，
 * 所以这里不加字段——宿主实况走 `host` 段，由宿主自己填（见下）。
 */
const status = {
  app: "sprout-mio",
  version: APP_VERSION,
  contractVersion: CONTRACT_VERSION,
  worker: "unimplemented",
  piSession: "unimplemented",
} as const;

/**
 * 宿主实况：只有宿主进程知道的事实（装载了哪个 extension、继承开关是开还是关、
 * 真实模型、真正声明的工具数）。extension 自己不推断，宿主填什么就报什么。
 *
 * 每一条都能被调用方拿独立来源对账：`run.id` 是这次 open 的 run id，`model` 是
 * Pi 真的在用那个模型，`activeTools` 等于工具面长度。换成常量字符串就立刻对不上。
 */
export interface SproutHostFacts {
  /** 谁填的：让工具返回的事实可以追溯到宿主进程，而不是 extension 自己编的。 */
  source: string;
  runtime: { node: string; pi: string };
  host: { inheritHostResources: boolean; extensions: string[] };
  session: { model: string; thinking: string; activeTools: number; registeredTools: number };
  run: { id: string };
}

const hostFacts: { current: SproutHostFacts | null } = { current: null };

/** 宿主在 ready 之前写入实况；一次 open 一个进程，不跨会话残留。 */
export function setSproutHostFacts(facts: SproutHostFacts): void {
  hostFacts.current = facts;
}

/** 当前宿主实况；没有宿主写过就是 null（独立 CLI 装载 extension 的情形）。 */
export function sproutHostFacts(): SproutHostFacts | null {
  return hostFacts.current;
}

/**
 * `sprout_status` 是工具的诊断入口：`registerSproutMcp` 的失败经 `mcpSurfaceDiagnostics()`
 * 出现在这里，不再只落在一个没人读的 `onError` 上（B2 的可见性要求）。
 */
export function sproutStatusPayload(): Record<string, unknown> {
  const surface = mcpSurfaceDiagnostics();
  const facts = hostFacts.current;
  return {
    ...status,
    ...(facts ? { host: facts } : {}),
    ...(surface.lastError ? { mcpSurfaceError: surface.lastError } : {}),
  };
}

/**
 * 注册 `sprout_status` 工具与 `sprout-status` 命令。
 *
 * 拆出来是因为两个装载路径都要它：`dist/extension/main.js`（独立 CLI）与
 * `scripts/pi-host-runner.mjs`（生产 Pi 分身）。生产 runner 只调 `src/extension/*`
 * 里的具名注册函数，不调 `main.ts` 的默认导出，所以工具必须能单独注册。
 */
export function registerSproutStatus(pi: SproutExtensionAPI): void {
  pi.registerTool({
    name: "sprout_status",
    label: "Sprout Status",
    description:
      "返回 Sprout Mio 版本、宿主实况与 MCP 工具面诊断。排查 Sprout 状态或工具为什么不可用时调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const current = sproutStatusPayload();
      return {
        content: [{ type: "text", text: JSON.stringify(current) }],
        details: { ...current },
      };
    },
  });
  pi.registerCommand("sprout-status", {
    description: "显示 Sprout Mio 版本与未实现边界。",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(sproutStatusPayload()), "info");
    },
  });
}
