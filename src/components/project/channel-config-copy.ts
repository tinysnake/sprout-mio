import type { ChannelConfigView } from "../../contracts/channel";
import type { AppError } from "../../contracts/result";

export const FEISHU_CONFIG_DESCRIPTION =
  "在飞书开放平台创建自建应用，把凭证填在这里。绑定和收发消息都用这份配置，其他 Project 各用各的。";
export const FEISHU_SECRET_KEPT_HINT = "已保存密钥，留空表示保持不变。";
export const FEISHU_SECRET_EMPTY_HINT = "只写入这台服务器的数据库，页面不会回显。";

export type ChannelConfigDraft = {
  enabled: boolean;
  origin: string;
  appId: string;
  appSecret: string;
};

export function channelConfigDraft(view: ChannelConfigView): ChannelConfigDraft {
  return {
    enabled: view.enabled,
    origin: view.settings.origin,
    appId: view.settings.appId,
    appSecret: "",
  };
}

export function channelConfigSaveInput(
  projectId: string,
  draft: ChannelConfigDraft,
  view: ChannelConfigView,
) {
  const appSecret = draft.appSecret.trim();
  return {
    projectId,
    kind: view.kind,
    enabled: draft.enabled,
    settings: { origin: draft.origin.trim(), appId: draft.appId.trim() },
    ...(appSecret ? { appSecret } : {}),
    revision: view.revision,
  };
}

export function channelConfigStatusLabel(view: ChannelConfigView): string {
  if (!view.configured) return "未配置";
  return view.enabled ? "已启用" : "已停用";
}

export function channelConfigFailureText(error: AppError): string {
  switch (error.code) {
    case "forbidden":
      return "只有 Human 可以修改渠道配置。";
    case "unauthorized":
      return "登录状态已失效，请重新登录后再试。";
    case "not_found":
      return "Project 不存在，或当前账号无权访问。";
    case "conflict":
      return `${error.message}，请按最新配置重试。`;
    default:
      return error.message;
  }
}
