import type { FeishuConnectionSnapshot } from "../../contracts/feishu-channel";
import type { FeishuRuntime } from "./runtime";

/**
 * 进程内运行实例的登记处。这里不 import SDK：读取连接状态的只读调用方
 * （server functions）不该顺带把传输实现拉进模块图。
 */
type FeishuRegistry = { runtimes: Map<string, FeishuRuntime> };

const globalRegistry = globalThis as typeof globalThis & {
  sproutFeishuRuntime?: FeishuRegistry;
};
const registry: FeishuRegistry = (globalRegistry.sproutFeishuRuntime ??= { runtimes: new Map() });

export function registerFeishuRuntime(projectId: string, runtime: FeishuRuntime | null): void {
  if (runtime) registry.runtimes.set(projectId, runtime);
  else registry.runtimes.delete(projectId);
}

export function currentFeishuRuntime(projectId: string): FeishuRuntime | null {
  return registry.runtimes.get(projectId) ?? null;
}

/** 没装配传输时的诊断快照：既不是 connecting 也不是 failed，而是没开。 */
export function feishuConnectionSnapshot(projectId: string): FeishuConnectionSnapshot {
  return (
    registry.runtimes.get(projectId)?.snapshot() ?? {
      appId: null,
      phase: "disabled",
      generation: 0,
      epochId: null,
      error: null,
      changedAtMs: 0,
    }
  );
}

export function stopFeishuRuntimes(): void {
  for (const runtime of registry.runtimes.values()) runtime.stop();
  registry.runtimes.clear();
}

export function wakeFeishuDelivery(): void {
  for (const runtime of registry.runtimes.values()) runtime.wake();
}
