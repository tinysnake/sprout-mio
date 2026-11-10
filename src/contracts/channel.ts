import { z } from "zod";
import type { FeishuTransportConfig } from "./feishu-channel";

export const channelKinds = ["feishu"] as const;
export const channelKindSchema = z.enum(channelKinds);
export type ChannelKind = z.infer<typeof channelKindSchema>;

const feishuSettingsSchema = z.strictObject({
  origin: z
    .string()
    .default("https://open.feishu.cn")
    .refine((value) => {
      try {
        const url = new URL(value);
        if (url.origin !== value) return false;
        if (url.protocol === "http:")
          return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        return (
          url.protocol === "https:" &&
          ["feishu.cn", "larksuite.com"].some(
            (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
          )
        );
      } catch {
        return false;
      }
    }, "必须是飞书 / Lark 官方域名，或回环地址上的 http origin"),
  appId: z
    .string()
    .default("")
    .refine(
      (value) => value === "" || /^cli_[0-9A-Za-z]{16}$/.test(value),
      "必须是 cli_ 开头的 appId",
    ),
});
const feishuSecretsSchema = z.strictObject({ appSecret: z.string().default("") });
type FeishuSettings = z.infer<typeof feishuSettingsSchema>;
type FeishuSecrets = z.infer<typeof feishuSecretsSchema>;

const feishuRequired = { settings: ["appId"], secrets: ["appSecret"] } as const;
function feishuConfigured(settings: FeishuSettings, secrets: FeishuSecrets): boolean {
  return (
    feishuRequired.settings.every((key) => settings[key].trim().length > 0) &&
    feishuRequired.secrets.every((key) => secrets[key].trim().length > 0)
  );
}

export const channelRegistry = {
  feishu: {
    label: "飞书",
    settingsSchema: feishuSettingsSchema,
    secretsSchema: feishuSecretsSchema,
    required: feishuRequired,
    configured: feishuConfigured,
    transport(input: {
      enabled: boolean;
      settings: FeishuSettings;
      secrets: FeishuSecrets;
    }): FeishuTransportConfig | null {
      return input.enabled && feishuConfigured(input.settings, input.secrets)
        ? { enabled: true, ...input.settings, ...input.secrets }
        : null;
    },
  },
} as const;

export const saveChannelConfigInput = z.discriminatedUnion("kind", [
  z.strictObject({
    projectId: z.string().min(1),
    kind: z.literal("feishu"),
    enabled: z.boolean(),
    settings: channelRegistry.feishu.settingsSchema,
    revision: z.number().int().nonnegative(),
    appSecret: channelRegistry.feishu.secretsSchema.shape.appSecret.removeDefault().optional(),
  }),
]);
export type SaveChannelConfigInput = z.infer<typeof saveChannelConfigInput>;
export type ChannelConfigView = {
  projectId: string;
  kind: "feishu";
  enabled: boolean;
  settings: FeishuSettings;
  hasAppSecret: boolean;
  configured: boolean;
  revision: number;
  updatedAtMs: number | null;
  updatedByHumanId: string | null;
};

export type ChannelRoute = {
  adapter: string;
  routeId: string;
  epochId: string;
  revision: number;
  humanId: string;
  projectId: string;
  chatId: string;
  destination: Readonly<Record<string, string>>;
};

export type ChannelEnvelope =
  | { kind: "text"; text: string; completeness: "complete" | "incomplete" | "oversized" }
  | {
      kind: "card";
      text: string;
      actions: { label: string; token: string }[];
    };

export type ChannelOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "not_accepted"; code: "rate_limited" | "unavailable" | "invalid_payload" }
  | { kind: "uncertain"; code: "timeout" | "ack_lost" | "ambiguous" };

export type ChannelRequest = {
  deliveryId: string;
  uuid: string;
  route: ChannelRoute;
  envelope: ChannelEnvelope;
};

// The adapter must hand the request to its I/O primitive inside begin, before returning.
export interface ChannelEmissionPort<Prepared> {
  prepare(request: ChannelRequest): Promise<Prepared>;
  begin(prepared: Prepared): {
    initiated: true;
    completion: Promise<ChannelOutcome>;
  };
}

export interface ChannelRouteBoundary {
  adapter: string;
  // Outbound delivery must also prove the connection that produced it is still current.
  assertCurrent(route: ChannelRoute): void;
  // An already delivered card outlives its connection: it needs the current route, not its epoch.
  assertActionCurrent(route: ChannelRoute): void;
}

export type ChannelActionResult =
  | { kind: "proposal"; status: string; workMessageId: string | null }
  | { kind: "watch"; active: true; watchId: string }
  | { kind: "watch"; rejected: true };

export type ChannelNativeAction =
  | { kind: "proposal"; proposalId: string; operationHash: string; action: "confirm" | "reject" }
  | { kind: "watch"; eventId: string; factHash: string; action: "confirm" | "reject" };
