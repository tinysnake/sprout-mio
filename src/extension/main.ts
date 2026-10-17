import { APP_VERSION, CONTRACT_VERSION } from "../contracts/version";
import type { SproutExtensionAPI } from "./types";

const status = {
  app: "sprout-mio",
  version: APP_VERSION,
  contractVersion: CONTRACT_VERSION,
  worker: "unimplemented",
  piSession: "unimplemented",
} as const;

export default function sproutExtension(pi: SproutExtensionAPI) {
  pi.registerTool({
    name: "sprout_status",
    label: "Sprout Status",
    description: "返回 Sprout Mio 版本与未实现边界。查询 Sprout 状态时调用此工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify(status) }], details: { ...status } };
    },
  });
  pi.registerCommand("sprout-status", {
    description: "显示 Sprout Mio 版本与未实现边界。",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(status), "info");
    },
  });
}
