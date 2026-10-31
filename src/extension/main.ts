import { registerSproutStatus } from "./status";

/**
 * 独立 extension 入口（`dist/extension/main.js`）。
 *
 * 工具与命令的定义在 `status.ts`：生产 Pi 分身的 runner 也调那一个注册函数，
 * 保证「独立 CLI 里的 `sprout_status`」和「分身里的 `sprout_status`」是同一份实现。
 */
export default function sproutExtension(pi: Parameters<typeof registerSproutStatus>[0]) {
  registerSproutStatus(pi);
}
