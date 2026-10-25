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

/** 对齐 Pi 1.4.0 实际调用的参数位置与结果错误标记。 */
export interface SproutExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      parameters: unknown,
      signal?: AbortSignal,
    ): Promise<SproutToolResult>;
  }): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(
        args: string,
        context: {
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
