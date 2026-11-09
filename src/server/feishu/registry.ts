import type { FeishuConnectionSnapshot } from "../../contracts/feishu-channel";
import type { FeishuRuntime } from "./runtime";

/**
 * 进程内运行实例的登记处。这里不 import SDK：读取连接状态的只读调用方
 * （server functions）不该顺带把传输实现拉进模块图。
 */
type FeishuRegistry = { runtime: FeishuRuntime | null };

const globalRegistry = globalThis as typeof globalThis & {
  sproutFeishuRuntime?: FeishuRegistry;
};
const registry: FeishuRegistry = (globalRegistry.sproutFeishuRuntime ??= { runtime: null });

export function registerFeishuRuntime(runtime: FeishuRuntime | null): void {
  registry.runtime = runtime;
}

export function currentFeishuRuntime(): FeishuRuntime | null {
  return registry.runtime;
}

/** 没装配传输时的诊断快照：既不是 connecting 也不是 failed，而是没开。 */
export function feishuConnectionSnapshot(): FeishuConnectionSnapshot {
  return (
    registry.runtime?.snapshot() ?? {
      appId: null,
      phase: "disabled",
      generation: 0,
      epochId: null,
      error: null,
      changedAtMs: 0,
    }
  );
}

export function wakeFeishuDelivery(): void {
  registry.runtime?.wake();
}
