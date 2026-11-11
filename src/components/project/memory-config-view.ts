import {
  memorySettingsSchema,
  resolveBankTarget,
  type MemoryActionFailure,
  type MemorySettings,
  type MemorySettingsView,
  type MemorySnapshot,
  type SaveMemoryConfigInput,
} from "../../contracts/memory";

export type MemoryConfigDraft = MemorySettings & { enabled: boolean; apiToken: string };

export function memoryConfigDraft(view: MemorySettingsView): MemoryConfigDraft {
  return {
    ...(view.config?.settings ?? view.defaults),
    enabled: view.config?.enabled ?? view.defaults.enabled,
    apiToken: "",
  };
}

export function memoryBankPreview(
  draft: Pick<MemorySettings, "bankPrefix" | "bankName">,
  projectId: string,
) {
  if (!draft.bankPrefix.trim() && !draft.bankName.trim())
    return { bank: null, error: "bank 前缀或名称至少填一个" };
  const settings = memorySettingsSchema.safeParse({
    bankPrefix: draft.bankPrefix,
    bankName: draft.bankName,
  });
  if (!settings.success) return { bank: null, error: "请检查记忆库名称格式与长度" };
  try {
    return { bank: resolveBankTarget(settings.data, projectId).bankId, error: null };
  } catch {
    return { bank: null, error: "记忆库名称无法解析，请检查名称与长度" };
  }
}

export function memoryConfigSaveInput(
  projectId: string,
  draft: MemoryConfigDraft,
  view: MemorySettingsView,
): SaveMemoryConfigInput {
  return {
    projectId,
    provider: "hindsight",
    enabled: draft.enabled,
    revision: view.config?.revision ?? 0,
    settings: {
      apiUrl: draft.apiUrl,
      bankPrefix: draft.bankPrefix,
      bankName: draft.bankName,
      autoIndexCommits: draft.autoIndexCommits,
      refreshPages: draft.refreshPages,
    },
    ...(draft.apiToken.trim() ? { secrets: { apiToken: draft.apiToken } } : {}),
  };
}

const UNAVAILABLE_STATUS = {
  invalid_config: { label: "配置有误", className: "text-destructive" },
  machine_offline: { label: "机器离线", className: "text-status-warning" },
  not_installed: { label: "未安装", className: "text-muted-foreground" },
  installing: { label: "安装中", className: "text-status-running" },
  install_failed: { label: "安装失败", className: "text-destructive" },
  extension_load_failed: { label: "加载失败", className: "text-destructive" },
};

export function memoryStatus(state: MemorySnapshot) {
  if (state.state === "disabled") return { label: "已关闭", className: "text-muted-foreground" };
  if (state.state === "ready") return { label: "已就绪", className: "text-status-success" };
  return UNAVAILABLE_STATUS[state.reason];
}

const ACTION_FAILURE_LABELS: Record<MemoryActionFailure["code"], string> = {
  unreachable: "服务不可达",
  unauthorized: "鉴权失败，请检查连接密钥",
  forbidden: "服务拒绝访问，请检查权限",
  server_error: "记忆服务错误",
};

export function memoryActionFailureText(failure: MemoryActionFailure): string {
  return `${ACTION_FAILURE_LABELS[failure.code]}。${failure.message}`;
}
