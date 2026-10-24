/** 仅声明本 extension 使用的 Pi API 子集。 */
export interface SproutToolResult {
  content: { type: "text"; text: string }[];
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
}
