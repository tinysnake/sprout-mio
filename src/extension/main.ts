import { APP_VERSION, CONTRACT_VERSION } from "../contracts/version";
import type { SproutExtensionAPI } from "./types";
import { mcpSurfaceDiagnostics } from "./mcp-extension";

const status = {
  app: "sprout-mio",
  version: APP_VERSION,
  contractVersion: CONTRACT_VERSION,
  worker: "unimplemented",
  piSession: "unimplemented",
} as const;

/**
 * `sprout_status` 是工具的诊断入口：`registerSproutMcp` 的失败经 `mcpSurfaceDiagnostics()`
 * 出现在这里，不再只落在一个没人读的 `onError` 上（B2 的可见性要求）。
 */
function withDiagnostics() {
  const surface = mcpSurfaceDiagnostics();
  return { ...status, ...(surface.lastError ? { mcpSurfaceError: surface.lastError } : {}) };
}

export default function sproutExtension(pi: SproutExtensionAPI) {
  pi.registerTool({
    name: "sprout_status",
    label: "Sprout Status",
    description: "返回 Sprout Mio 版本与未实现边界。查询 Sprout 状态时调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const current = withDiagnostics();
      return {
        content: [{ type: "text", text: JSON.stringify(current) }],
        details: { ...current },
      };
    },
  });
  pi.registerCommand("sprout-status", {
    description: "显示 Sprout Mio 版本与未实现边界。",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(withDiagnostics()), "info");
    },
  });
}
