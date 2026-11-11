import { eq } from "drizzle-orm";
import {
  HINDSIGHT_EXTENSION_VERSION,
  memoryDefaults,
  resolveBankTarget,
  saveMemoryConfigInput,
  type MemorySettingsView,
} from "../contracts/memory";
import type { DatabaseConnection } from "../db/connection";
import { memoryConfig } from "../db/schema";
import type { ProjectContext } from "../domain/access";
import {
  assertMemoryConfigHuman,
  loadMemoryConfig,
  saveMemoryConfig,
} from "../domain/memory-config";
import { readMemoryInstall, type ProvisionMemoryExtensionOptions } from "./memory-install";
import { resolveMemoryRuntime } from "./memory-runtime";

type MemoryDatabase = DatabaseConnection["db"];
type Provision = (options: ProvisionMemoryExtensionOptions) => Promise<unknown>;
export type MemorySettingsDependencies = {
  db: MemoryDatabase;
  machineId: string | null;
  dataDir: string;
  now: () => number;
  provision: Provision;
};

export function getMemorySettings(
  deps: Pick<MemorySettingsDependencies, "db" | "machineId" | "dataDir">,
  projectId: string,
): MemorySettingsView {
  const config = loadMemoryConfig(deps.db, projectId, "hindsight");
  const runtime = resolveMemoryRuntime({
    db: deps.db,
    projectId,
    machineId: deps.machineId ?? undefined,
    machineOnline: deps.machineId !== null,
    dataDir: deps.dataDir,
    env: process.env,
  });
  const install = deps.machineId ? readMemoryInstall(deps.db, deps.machineId) : null;
  return {
    config,
    effectiveState: runtime.state === "ready" ? { state: "ready", bank: runtime.bank } : runtime,
    bankPreview: resolveBankTarget(config?.settings ?? memoryDefaults, projectId),
    machineId: deps.machineId,
    install: install
      ? { status: install.status, version: install.version, error: install.error }
      : null,
    extensionVersion: HINDSIGHT_EXTENSION_VERSION,
    defaults: memoryDefaults,
    message:
      runtime.state === "unavailable" && runtime.reason === "machine_offline"
        ? "当前服务未绑定 Machine，请配置 SPROUT_PI_MACHINE_ID 后重启服务，再保存以安装记忆组件。"
        : null,
  };
}

export function saveMemorySettings(
  deps: MemorySettingsDependencies,
  raw: unknown,
  context: ProjectContext,
): MemorySettingsView {
  assertMemoryConfigHuman(context);
  const input = saveMemoryConfigInput.parse(raw);
  const saved = saveMemoryConfig(deps.db, input, context.userId, deps.now());
  if (saved.enabled && deps.machineId) {
    try {
      // The installer persists installing before yielding, and failed before rejecting.
      void deps
        .provision({
          db: deps.db,
          machineId: deps.machineId,
          dataDir: deps.dataDir,
          now: deps.now,
        })
        .catch(() => {
          console.error("[memory] 记忆组件安装失败", { machineId: deps.machineId });
        });
    } catch {
      console.error("[memory] 记忆组件安装启动失败", { machineId: deps.machineId });
    }
  }
  return getMemorySettings(deps, saved.projectId);
}

export async function provisionEnabledMemories({
  db,
  machineId,
  dataDir,
  provision,
}: Pick<MemorySettingsDependencies, "db" | "machineId" | "dataDir" | "provision">): Promise<void> {
  if (!machineId) return;
  const enabled = db.select().from(memoryConfig).where(eq(memoryConfig.enabled, true)).all();
  for (const config of enabled) {
    if (
      getMemorySettings({ db, machineId, dataDir }, config.projectId).effectiveState.state ===
      "ready"
    )
      return;
    try {
      await provision({ db, machineId, dataDir });
      // Installation is shared by every Project on this Machine.
      return;
    } catch {
      console.error("[memory] 启动时安装记忆组件失败", { machineId, projectId: config.projectId });
    }
  }
}
