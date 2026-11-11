import { and, eq } from "drizzle-orm";
import {
  HINDSIGHT_EXTENSION_VERSION,
  memoryProviderSchema,
  memorySecretsSchema,
  memorySettingsSchema,
  resolveApiUrl,
  resolveBankTarget,
  saveMemoryConfigInput,
  type EffectiveMemoryState,
  type MemoryConfigView,
  type MemoryInstallStatus,
  type MemoryProvider,
} from "../contracts/memory";
import type { DatabaseConnection } from "../db/connection";
import { memoryConfig, project, user } from "../db/schema";
import type { ProjectContext } from "./access";

type MemoryDatabase = DatabaseConnection["db"];
type MemoryConfigRow = typeof memoryConfig.$inferSelect;

export class MemoryConfigError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "validation_failed",
    message: string,
  ) {
    super(message);
    this.name = "MemoryConfigError";
  }
}

export function assertMemoryConfigHuman(ctx: ProjectContext): void {
  if (ctx.agent) throw new MemoryConfigError("forbidden", "只有 Human 可以管理记忆配置");
}

function loadRow(
  db: Pick<MemoryDatabase, "select">,
  projectId: string,
  provider: MemoryProvider,
): MemoryConfigRow | undefined {
  return db
    .select()
    .from(memoryConfig)
    .where(
      and(
        eq(memoryConfig.projectId, projectId),
        eq(memoryConfig.provider, memoryProviderSchema.parse(provider)),
      ),
    )
    .get();
}

function toView(row: MemoryConfigRow): MemoryConfigView {
  const secrets = memorySecretsSchema.parse(row.secrets);
  return {
    projectId: row.projectId,
    provider: memoryProviderSchema.parse(row.provider),
    enabled: row.enabled,
    settings: memorySettingsSchema.parse(row.settings),
    hasToken: secrets.apiToken.length > 0,
    revision: row.revision,
    updatedAtMs: row.updatedAtMs,
    updatedByHumanId: row.updatedByHumanId,
  };
}

export function loadMemoryConfig(
  db: MemoryDatabase,
  projectId: string,
  provider: MemoryProvider,
): MemoryConfigView | null {
  const row = loadRow(db, projectId, provider);
  return row ? toView(row) : null;
}

export function saveMemoryConfig(
  db: MemoryDatabase,
  input: unknown,
  humanId: string,
  now: number,
): MemoryConfigView {
  const parsed = saveMemoryConfigInput.parse(input);
  return db.transaction(
    (tx) => {
      const owner = tx
        .select({ id: user.id })
        .from(project)
        .innerJoin(user, eq(user.id, project.createdBy))
        .where(and(eq(project.id, parsed.projectId), eq(user.id, humanId)))
        .get();
      if (!owner)
        throw new MemoryConfigError("forbidden", "只有 Project 的 Human 可以管理记忆配置");
      const current = loadRow(tx, parsed.projectId, parsed.provider);
      if ((current?.revision ?? 0) !== parsed.revision)
        throw new MemoryConfigError("conflict", "记忆配置已变化，请刷新后重试");
      resolveApiUrl(parsed.settings, process.env);
      resolveBankTarget(parsed.settings, parsed.projectId);
      const previousSecrets = memorySecretsSchema.parse(current?.secrets ?? {});
      const secrets = memorySecretsSchema.parse({
        apiToken: parsed.secrets?.apiToken || previousSecrets.apiToken,
      });
      const values = {
        projectId: parsed.projectId,
        provider: parsed.provider,
        enabled: parsed.enabled,
        settings: parsed.settings,
        secrets,
        revision: parsed.revision + 1,
        updatedAtMs: Math.max(now, (current?.updatedAtMs ?? 0) + 1),
        updatedByHumanId: humanId,
      };
      const saved = current
        ? tx
            .update(memoryConfig)
            .set(values)
            .where(
              and(
                eq(memoryConfig.projectId, parsed.projectId),
                eq(memoryConfig.provider, parsed.provider),
              ),
            )
            .returning()
            .get()!
        : tx.insert(memoryConfig).values(values).returning().get()!;
      return toView(saved);
    },
    { behavior: "immediate" },
  );
}

export function resolveEffectiveMemoryState(input: {
  enabled: boolean;
  configValid: boolean;
  install: { status: MemoryInstallStatus; version: string } | null;
}): EffectiveMemoryState {
  if (!input.enabled) return { state: "disabled" };
  if (!input.configValid) return { state: "unavailable", reason: "invalid_config" };
  const install = input.install;
  if (!install || install.status === "missing" || install.version !== HINDSIGHT_EXTENSION_VERSION)
    return { state: "unavailable", reason: "not_installed" };
  if (install.status === "installing") return { state: "unavailable", reason: "installing" };
  if (install.status === "failed") return { state: "unavailable", reason: "install_failed" };
  return { state: "ready" };
}
