/** 仅声明本 extension 使用的 Pi API 子集。 */

/**
 * Pi 工具结果的内容块。`image` 是 Pi `AgentToolResult.content` 的合法成员
 * （`@earendil-works/pi-agent-core` 的 `TextContent | ImageContent`），MCP 的图片块
 * 必须原样走到这里，不能降级成 JSON 文本。
 */
export type SproutToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface SproutToolResult {
  content: SproutToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Pi 交给工具/命令执行的上下文里本 extension 真的读的那一部分（Pi `ExtensionToolContext`、
 * `ExtensionCommandContext` 都继承 `ExtensionContext`，`sessionManager` 在其中）。
 *
 * 只声明用来对账的两条：没有宿主写过实况时，会话身份从这里读，不从别处猜。
 */
export interface SproutToolContext {
  sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | null;
  };
}

/** 对齐 Pi 1.4.0 实际调用的参数位置与结果错误标记。 */
export interface SproutExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    /**
     * Pi 的位置参数依次是 `(toolCallId, params, signal, onUpdate, context)`：
     * `onUpdate` 必须占住第四位，否则第五位的 `context` 会收到一个回调函数。
     */
    execute(
      toolCallId: string,
      parameters: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      context?: SproutToolContext,
    ): Promise<SproutToolResult>;
  }): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(
        args: string,
        context: SproutToolContext & {
          ui: { notify(message: string, type: "info"): void };
        },
      ): Promise<void>;
    },
  ): void;
  /**
   * 声明给模型的工具名（Pi `AgentToolApi.getActiveTools`，types.d.ts:1282）。
   * 可选：只用来核对「注册成功」是否等于「进入模型工具面」，缺席时核对结果记为未知。
   */
  getActiveTools?(): string[];
}

/** 工具面核对结果：`unknown` 只表示没有 `getActiveTools` 可问，不表示通过。 */
export type ToolSurfaceCheck =
  | { state: "declared" }
  | { state: "unknown"; reason: string }
  | { state: "missing"; tools: string[] };
