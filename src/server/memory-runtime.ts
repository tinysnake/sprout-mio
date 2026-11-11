import { statSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  HINDSIGHT_EXTENSION_VERSION,
  memoryDefaults,
  memorySecretsSchema,
  memorySettingsSchema,
  resolveApiUrl,
  resolveBankTarget,
  type MemoryRuntime,
} from "../contracts/memory";
import type { DatabaseConnection } from "../db/connection";
import { memoryConfig } from "../db/schema";
import { resolveEffectiveMemoryState } from "../domain/memory-config";
import { readMemoryInstall } from "./memory-install";

export function resolveMemoryRuntime(input: {
  db: DatabaseConnection["db"];
  projectId: string;
  machineId?: string;
  machineOnline: boolean;
  dataDir: string;
  env: { SPROUT_HINDSIGHT_API_URL?: string };
}): MemoryRuntime {
  let enabled: boolean = memoryDefaults.enabled;
  let config: { apiUrl: string; bank: string; apiToken: string } | undefined;
  try {
    const row = input.db
      .select()
      .from(memoryConfig)
      .where(
        and(eq(memoryConfig.projectId, input.projectId), eq(memoryConfig.provider, "hindsight")),
      )
      .get();
    enabled = row?.enabled ?? memoryDefaults.enabled;
    if (!enabled) return { state: "disabled" };
    const settings = memorySettingsSchema.parse(row?.settings ?? {});
    const secrets = memorySecretsSchema.parse(row?.secrets ?? {});
    config = {
      apiUrl: resolveApiUrl(settings, input.env),
      bank: resolveBankTarget(settings, input.projectId).bankId,
      apiToken: secrets.apiToken,
    };
  } catch {
    // Invalid stored settings must not prevent an ordinary turn.
  }
  const state = resolveEffectiveMemoryState({
    enabled,
    configValid: config !== undefined,
    machineOnline: input.machineOnline && Boolean(input.machineId),
    install: input.machineId ? readMemoryInstall(input.db, input.machineId) : null,
  });
  if (state.state !== "ready") return state;
  if (!config) return { state: "unavailable", reason: "invalid_config" };
  const bundlePath = join(
    input.dataDir,
    "extensions",
    "hindsight",
    HINDSIGHT_EXTENSION_VERSION,
    "package/dist/pi.js",
  );
  try {
    if (statSync(bundlePath).isFile()) return { state: "ready", ...config, bundlePath };
  } catch {
    // The install row can outlive files removed from the execution host.
  }
  return { state: "unavailable", reason: "not_installed" };
}
