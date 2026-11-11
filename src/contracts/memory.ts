import { z } from "zod";

export const HINDSIGHT_EXTENSION_VERSION = "0.8.7";
export const HINDSIGHT_EXTENSION_INTEGRITY =
  "sha512-GuGJdqvcPQpUuu9jWOjJa5OtaI/eAx20DgsiLKKEhfuSCDZXDBWH8Aa7lyj03dAVLMt40K7IciUBtD81QhdTBg==";

export const MEMORY_TOOL_NAMES = [
  "hindsight_sync_status",
  "hindsight_diagnose",
  "hindsight_search_pages",
  "hindsight_list_pages",
  "hindsight_read_page",
  "hindsight_reflect",
  "hindsight_capture_initiative",
  "hindsight_ingest_document",
] as const;

export const HINDSIGHT_DEFAULT_API_URL = "http://127.0.0.1:8888";

export const memoryDefaults = {
  enabled: true,
  apiUrl: "",
  bankPrefix: "sprout",
  bankName: "",
  autoIndexCommits: true,
  refreshPages: true,
  version: HINDSIGHT_EXTENSION_VERSION,
} as const;

export const memoryProviderSchema = z.literal("hindsight");
export type MemoryProvider = z.infer<typeof memoryProviderSchema>;

function isMemoryApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname;
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "[::1]"
    )
      return true;
    const labels = host.split(".");
    if (labels.length !== 4 || !labels.every((part) => /^\d{1,3}$/.test(part) && +part <= 255))
      return false;
    const [a, b] = labels.map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  } catch {
    return false;
  }
}

const apiUrlSchema = z
  .string()
  .trim()
  .refine(isMemoryApiUrl, "必须使用 https，或回环 / 内网 http 地址");
const bankPrefixSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_-]{0,32}$/);
const bankNameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9._-]{0,96}$/);
const bankFieldsSchema = z
  .strictObject({ bankPrefix: bankPrefixSchema, bankName: bankNameSchema })
  .refine(({ bankPrefix, bankName }) => bankPrefix !== "" || bankName !== "", "bank 不能为空")
  .refine(
    ({ bankPrefix, bankName }) =>
      !bankPrefix || !bankName || `${bankPrefix}::${bankName}`.length <= 128,
    "完整 bank 不能超过 128 字符",
  );

export const memorySettingsSchema = z
  .strictObject({
    apiUrl: z
      .string()
      .trim()
      .default("")
      .refine((value) => value === "" || isMemoryApiUrl(value)),
    bankPrefix: bankPrefixSchema.default(memoryDefaults.bankPrefix),
    bankName: bankNameSchema.default(memoryDefaults.bankName),
    autoIndexCommits: z.boolean().default(memoryDefaults.autoIndexCommits),
    refreshPages: z.boolean().default(memoryDefaults.refreshPages),
  })
  .superRefine((settings, ctx) => {
    const result = bankFieldsSchema.safeParse({
      bankPrefix: settings.bankPrefix,
      bankName: settings.bankName,
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  });
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

export const memorySecretsSchema = z.strictObject({ apiToken: z.string().trim().default("") });
export type MemorySecrets = z.infer<typeof memorySecretsSchema>;

export const saveMemoryConfigInput = z.strictObject({
  projectId: z.string().min(1),
  provider: memoryProviderSchema,
  enabled: z.boolean(),
  settings: memorySettingsSchema,
  secrets: memorySecretsSchema.optional(),
  revision: z.number().int().nonnegative(),
});
export type SaveMemoryConfigInput = z.infer<typeof saveMemoryConfigInput>;

export const clearMemoryInput = z.strictObject({
  projectId: z.string().min(1),
  confirmName: z.string(),
});
export type ClearMemoryInput = z.infer<typeof clearMemoryInput>;

export type MemoryActionFailure = {
  ok: false;
  code: "unreachable" | "unauthorized" | "forbidden" | "server_error";
  status?: number;
  message: string;
};
export type TestMemoryConnectionResult =
  | { ok: true; bankExists: true; created: boolean }
  | MemoryActionFailure;
export type ClearMemoryResult = { ok: true } | MemoryActionFailure;
export type RetryMemoryInstallResult = {
  machineId: string;
  install: MemorySettingsView["install"];
};

export type MemoryConfigView = {
  projectId: string;
  provider: MemoryProvider;
  enabled: boolean;
  settings: MemorySettings;
  hasToken: boolean;
  revision: number;
  updatedAtMs: number;
  updatedByHumanId: string | null;
};

export type MemorySettingsView = {
  config: MemoryConfigView | null;
  effectiveState: MemorySnapshot;
  bankPreview: MemoryBankTarget;
  machineId: string | null;
  install: { status: MemoryInstallStatus; version: string; error: string | null } | null;
  extensionVersion: string;
  defaults: typeof memoryDefaults;
  message: string | null;
};

export function resolveApiUrl(
  settings: Pick<MemorySettings, "apiUrl">,
  env: { SPROUT_HINDSIGHT_API_URL?: string },
): string {
  return apiUrlSchema.parse(
    settings.apiUrl.trim() || env.SPROUT_HINDSIGHT_API_URL?.trim() || HINDSIGHT_DEFAULT_API_URL,
  );
}

export type MemoryBankTarget =
  | { kind: "bare"; bankId: string }
  | { kind: "namespaced"; bankId: string };

export function resolveBankTarget(
  input: Pick<MemorySettings, "bankPrefix" | "bankName">,
  projectId: string,
): MemoryBankTarget {
  const { bankPrefix, bankName } = bankFieldsSchema.parse({
    bankPrefix: input.bankPrefix,
    bankName: input.bankName,
  });
  if (!bankPrefix) return { kind: "bare", bankId: bankName };
  const name = bankName || bankNameSchema.min(1).parse(projectId);
  const bankId = z.string().max(128).parse(`${bankPrefix}::${name}`);
  return { kind: "namespaced", bankId };
}

export const memoryInstallStatusSchema = z.enum(["missing", "installing", "ready", "failed"]);
export type MemoryInstallStatus = z.infer<typeof memoryInstallStatusSchema>;
export const memoryUnavailableReasonSchema = z.enum([
  "invalid_config",
  "machine_offline",
  "not_installed",
  "installing",
  "install_failed",
  "extension_load_failed",
]);

export const memorySnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }),
  z.object({
    state: z.literal("unavailable"),
    reason: memoryUnavailableReasonSchema,
    bank: z.string().optional(),
  }),
  z.object({ state: z.literal("ready"), bank: z.string() }),
]);
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export type MemoryRuntime =
  | Exclude<MemorySnapshot, { state: "ready" }>
  | { state: "ready"; apiUrl: string; bank: string; apiToken: string; bundlePath: string };

export function filterMemorySkillPaths(
  paths: readonly string[],
  state: MemoryRuntime["state"],
): string[] {
  return paths.filter(
    (path) =>
      state === "ready" || !`/${path.replaceAll("\\", "/")}/`.includes("/hindsight-coding-agent/"),
  );
}

export function memoryExtensionConfig(memory: Extract<MemoryRuntime, { state: "ready" }>) {
  return {
    serverMode: "self-hosted" as const,
    apiUrl: memory.apiUrl,
    bankId: memory.bank,
    dynamicBankId: false,
    autoUpdate: false,
    autoSeed: false,
  };
}

export type EffectiveMemoryState =
  | { state: "disabled" }
  | {
      state: "unavailable";
      reason:
        | "invalid_config"
        | "machine_offline"
        | "not_installed"
        | "installing"
        | "install_failed";
    }
  | { state: "ready" };
