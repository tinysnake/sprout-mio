import { db } from "../db";
import { channelConfig } from "../db/schema";
import { channelRuntimeConfig, loadChannelConfigRow } from "../domain/channel-config";
import { recordDiagnostic } from "./diagnostics";
import { createFeishuRuntime, feishuTransportConfig } from "./feishu/runtime";
import { currentFeishuRuntime, registerFeishuRuntime } from "./feishu/registry";

const reloads = new Map<string, Promise<void>>();

export function reloadChannelRuntime(projectId: string): Promise<void> {
  const next = (reloads.get(projectId) ?? Promise.resolve()).then(() => {
    try {
      currentFeishuRuntime(projectId)?.stop();
      registerFeishuRuntime(projectId, null);
      const config = channelRuntimeConfig(loadChannelConfigRow(projectId, "feishu"));
      if (!config) return;
      const runtime = createFeishuRuntime({
        projectId,
        config: feishuTransportConfig(config),
        onError: () => reportReloadFailure(projectId),
      });
      registerFeishuRuntime(projectId, runtime);
      try {
        runtime.start();
      } catch (error) {
        registerFeishuRuntime(projectId, null);
        runtime.stop();
        throw error;
      }
    } catch {
      // 配置已提交；连接故障只能记诊断，不能把成功的保存伪装成回滚。
      reportReloadFailure(projectId);
    }
  });
  reloads.set(projectId, next);
  void next.finally(() => {
    if (reloads.get(projectId) === next) reloads.delete(projectId);
  });
  return next;
}

function reportReloadFailure(projectId: string): void {
  recordDiagnostic({
    level: "error",
    requestId: "channel_config_reload",
    projectId,
    event: "channel.runtime_reload_failed",
    message: "渠道配置已保存，但运行时重载失败",
    data: { projectId, kind: "feishu" },
  });
}

export async function startChannelRuntimes(): Promise<void> {
  const rows: (typeof channelConfig.$inferSelect)[] = db.select().from(channelConfig).all();
  await Promise.all(
    rows
      .filter((row) => row.kind === "feishu" && row.enabled)
      .map((row) => reloadChannelRuntime(row.projectId)),
  );
}
