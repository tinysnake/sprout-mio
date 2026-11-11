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
  dataDir: string;
  now: () => number;
  provision: Provision;
};

export function getMemorySettings(
  deps: Pick<MemorySettingsDependencies, "db" | "dataDir">,
  projectId: string,
): MemorySettingsView {
  const config = loadMemoryConfig(deps.db, projectId, "hindsight");
  const runtime = resolveMemoryRuntime({
    db: deps.db,
    projectId,
    dataDir: deps.dataDir,
    env: process.env,
  });
  const install = readMemoryInstall(deps.db);
  return {
    config,
    effectiveState: runtime.state === "ready" ? { state: "ready", bank: runtime.bank } : runtime,
    bankPreview: resolveBankTarget(config?.settings ?? memoryDefaults, projectId),
    install: install
      ? { status: install.status, version: install.version, error: install.error }
      : null,
    extensionVersion: HINDSIGHT_EXTENSION_VERSION,
    defaults: memoryDefaults,
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
  if (saved.enabled) {
    try {
      // The installer persists installing before yielding, and failed before rejecting.
      void deps
        .provision({
          db: deps.db,
          dataDir: deps.dataDir,
          now: deps.now,
        })
        .catch(() => {
          console.error("[memory] 记忆组件安装失败", { projectId: saved.projectId });
        });
    } catch {
      console.error("[memory] 记忆组件安装启动失败", { projectId: saved.projectId });
    }
  }
  return getMemorySettings(deps, saved.projectId);
}

export async function provisionEnabledMemories({
  db,
  dataDir,
  provision,
}: Pick<MemorySettingsDependencies, "db" | "dataDir" | "provision">): Promise<void> {
  const enabled = db.select().from(memoryConfig).where(eq(memoryConfig.enabled, true)).all();
  if (enabled.length === 0) return;
  const install = readMemoryInstall(db);
  if (install?.status === "ready" && install.version === HINDSIGHT_EXTENSION_VERSION) return;
  try {
    await provision({ db, dataDir });
  } catch {
    console.error("[memory] 启动时安装记忆组件失败", { projectId: enabled[0]?.projectId });
  }
}
