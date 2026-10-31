import { APP_VERSION, CONTRACT_VERSION } from "../contracts/version";
import type { SproutExtensionAPI, SproutToolContext } from "./types";
import { mcpSurfaceDiagnostics } from "./mcp-extension";

/**
 * `sprout_status` 的载荷：版本 + 进程/会话事实 + 诊断槽。
 *
 * `worker` 与 `piSession` 原来是 P1 的边界声明（恒为 `"unimplemented"`）。P7 的分身已经是
 * 真进程、真会话，诊断入口再报「未实现」就是把排查引到错的方向，所以这两条改成报实时事实：
 * `worker` 来自 `process` 与装载者自报，`piSession` 来自宿主写入的会话身份。
 */
const status = {
  app: "sprout-mio",
  version: APP_VERSION,
  contractVersion: CONTRACT_VERSION,
} as const;

/** 装载方式：谁把这份 extension 装进 Pi 进程，决定 `worker` 是哪种 Worker。 */
export type SproutLoader = "pi-host-runner" | "standalone-cli";

/**
 * `piSession` 事实：谁写的、会话身份是什么。
 *
 * `host` 是**写入者**，不是猜测：`"none"` 表示没有 Sprout 宿主写过实况
 * （`dist/extension/main.js` 被独立 Pi CLI 装载），此时 `id`/`file` 取自 Pi 自己的
 * session manager——仍然是这条会话的真事实，只是写它的不是 Sprout 宿主。
 */
export interface SproutPiSessionFact {
  host: SproutLoader | "none";
  id: string | null;
  file: string | null;
}

/**
 * 宿主实况：只有宿主进程知道的事实（装载了哪个 extension、继承开关是开还是关、
 * 真实模型、真正声明的工具数、会话身份）。extension 自己不推断，宿主填什么就报什么。
 *
 * 每一条都能被调用方拿独立来源对账：`run.id` 是这次 open 的 run id，`model` 是
 * Pi 真的在用那个模型，`activeTools` 等于工具面长度，`session.id` 是 Pi 落盘的会话 id。
 * 换成常量字符串就立刻对不上。
 */
export interface SproutHostFacts {
  /** 谁填的：让工具返回的事实可以追溯到宿主进程，而不是 extension 自己编的。 */
  source: string;
  /** 以哪种方式装载的，由装载者用自己的名字填（见 `scripts/pi-host-runner.mjs`）。 */
  loader: SproutLoader;
  runtime: { node: string; pi: string };
  host: { inheritHostResources: boolean; extensions: string[] };
  session: {
    /** Pi 会话身份：与落盘 session 文件里的 id 同一份。 */
    id: string;
    file: string | null;
    model: string;
    thinking: string;
    activeTools: number;
    registeredTools: number;
  };
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
 *
 * `context` 是 Pi 交给工具执行的上下文。有它就多一条真来源：没有宿主写过实况时，
 * `piSession` 取 Pi 自己 session manager 里的会话 id 与文件，而不是报空。
 */
export function sproutStatusPayload(context?: SproutToolContext): Record<string, unknown> {
  const surface = mcpSurfaceDiagnostics();
  const facts = hostFacts.current;
  const manager = context?.sessionManager;
  return {
    ...status,
    // `pid` 是正在跑 Pi 的那个进程，不是常量：宿主实况缺席时它也照样真实。
    worker: { pid: process.pid, loader: facts?.loader ?? "standalone-cli" },
    piSession: {
      host: facts?.source ?? "none",
      id: facts?.session.id ?? manager?.getSessionId?.() ?? null,
      file: facts?.session.file ?? manager?.getSessionFile?.() ?? null,
    },
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
      "返回 Sprout Mio 版本、宿主实况、Worker 进程与会话身份、MCP 工具面诊断。排查 Sprout 状态或工具为什么不可用时调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _parameters, _signal, _onUpdate, context) {
      const current = sproutStatusPayload(context);
      return {
        content: [{ type: "text", text: JSON.stringify(current) }],
        details: { ...current },
      };
    },
  });
  pi.registerCommand("sprout-status", {
    description: "显示 Sprout Mio 版本、宿主实况与 Worker/会话事实。",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(sproutStatusPayload(context)), "info");
    },
  });
}
