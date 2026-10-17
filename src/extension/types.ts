/** 仅声明本 extension 使用的 JSON Schema 子集，禁止添加未使用的 Pi API。 */
export interface EmptyParameters {
  type: "object";
  properties: Record<string, never>;
  additionalProperties: false;
}

/** 对齐 Pi 1.3.0 的注册形状，升级 Pi 时需要重新复核。 */
export interface SproutExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: EmptyParameters;
    execute(): Promise<{
      content: { type: "text"; text: string }[];
      details: Record<string, unknown>;
    }>;
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
