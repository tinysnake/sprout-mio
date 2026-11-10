import { and, eq, ne } from "drizzle-orm";
import {
  channelKindSchema,
  channelRegistry,
  saveChannelConfigInput,
  type ChannelConfigView,
  type ChannelKind,
} from "../contracts/channel";
import { db, sqlite } from "../db";
import { channelConfig } from "../db/schema";
import { assertProjectAccess, type ProjectContext } from "./access";

type ChannelConfigRow = typeof channelConfig.$inferSelect;
export class ChannelConfigError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "validation_failed",
    message: string,
  ) {
    super(message);
    this.name = "ChannelConfigError";
  }
}

export function assertChannelConfigHuman(ctx: ProjectContext): void {
  if (ctx.agent) throw new ChannelConfigError("forbidden", "只有 Human 可以管理渠道配置");
}

export function loadChannelConfigRow(
  projectId: string,
  kind: ChannelKind,
): ChannelConfigRow | undefined {
  return db
    .select()
    .from(channelConfig)
    .where(
      and(
        eq(channelConfig.projectId, projectId),
        eq(channelConfig.kind, channelKindSchema.parse(kind)),
      ),
    )
    .get();
}

function parseRow(row: ChannelConfigRow | undefined, kind: ChannelKind = "feishu") {
  const definition = channelRegistry[channelKindSchema.parse(row?.kind ?? kind)];
  return {
    definition,
    settings: definition.settingsSchema.parse(row?.settings ?? {}),
    secrets: definition.secretsSchema.parse(row?.secrets ?? {}),
  };
}

export function toChannelConfigView(
  row: ChannelConfigRow | undefined,
  projectId: string,
  kind: ChannelKind = "feishu",
): ChannelConfigView {
  const { definition, settings, secrets } = parseRow(row, kind);
  return {
    projectId,
    kind: channelKindSchema.parse(row?.kind ?? kind),
    enabled: row?.enabled ?? false,
    settings,
    hasAppSecret: secrets.appSecret.trim().length > 0,
    configured: definition.configured(settings, secrets),
    revision: row?.revision ?? 0,
    updatedAtMs: row?.updatedAtMs ?? null,
    updatedByHumanId: row?.updatedByHumanId ?? null,
  };
}

export function channelRuntimeConfig(row: ChannelConfigRow | undefined) {
  const { definition, settings, secrets } = parseRow(row);
  return definition.transport({ enabled: row?.enabled ?? false, settings, secrets });
}

export function saveChannelConfig(
  input: unknown,
  humanId: string,
  now = new Date(),
): ChannelConfigView {
  const parsed = saveChannelConfigInput.parse(input);
  return sqlite
    .transaction(() => {
      assertProjectAccess({ userId: humanId, requestId: "channel_config" }, parsed.projectId);
      const current = loadChannelConfigRow(parsed.projectId, parsed.kind);
      if ((current?.revision ?? 0) !== parsed.revision)
        throw new ChannelConfigError("conflict", "渠道配置已变化，请刷新后重试");
      if (parsed.settings.appId) {
        const others: ChannelConfigRow[] = db
          .select()
          .from(channelConfig)
          .where(
            and(eq(channelConfig.kind, parsed.kind), ne(channelConfig.projectId, parsed.projectId)),
          )
          .all();
        if (others.some((row) => row.settings.appId === parsed.settings.appId))
          throw new ChannelConfigError(
            "conflict",
            "这个飞书应用已被其他 Project 使用，请使用不同的应用",
          );
      }
      const { definition, secrets: previousSecrets } = parseRow(current, parsed.kind);
      const secrets = definition.secretsSchema.parse({
        appSecret: parsed.appSecret ?? previousSecrets.appSecret,
      });
      if (parsed.enabled && !definition.configured(parsed.settings, secrets))
        throw new ChannelConfigError("validation_failed", "启用渠道需要补齐必填配置");
      const values = {
        projectId: parsed.projectId,
        kind: parsed.kind,
        enabled: parsed.enabled,
        settings: parsed.settings,
        secrets,
        revision: parsed.revision + 1,
        updatedAtMs: now.getTime(),
        updatedByHumanId: humanId,
      };
      const saved = current
        ? db
            .update(channelConfig)
            .set(values)
            .where(
              and(
                eq(channelConfig.projectId, parsed.projectId),
                eq(channelConfig.kind, parsed.kind),
              ),
            )
            .returning()
            .get()!
        : db.insert(channelConfig).values(values).returning().get()!;
      return toChannelConfigView(saved, parsed.projectId);
    })
    .immediate();
}
