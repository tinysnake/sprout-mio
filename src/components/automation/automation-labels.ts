export const AUTOMATION_MODES = {
  enabled: "自动接续已启用",
  off: "自动接续已关闭",
};

export const AUTOMATION_DECISIONS = {
  continue: "建议接续",
  do_not_continue: "本轮无需接续",
  indeterminate: "未能得出可靠结论",
};

export const AUTOMATION_STATES = {
  pending: "等待检查",
  claimed: "正在检查",
  retry_wait: "检查失败 · 等待重试",
  decided: "已完成检查",
  attention: "检查失败 · 需要处理",
  stale: "检查已失效",
  canceled: "检查已取消",
};

export const automationTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";

/** 内部失败码只说给人听的话，码本身留在 data-error-code 上给门禁与排查用。 */
const AUTOMATION_FAILURES: Record<string, string> = {
  provider_timeout: "判定服务没有及时回应",
  provider_unavailable: "判定服务当前不可用",
  provider_auth_failed: "判定服务的凭据无效",
  provider_invalid_response: "判定服务返回了无法识别的结果",
  provider_low_certainty: "判定服务的把握不足",
  context_budget_exceeded: "本轮上下文超出预算",
  context_stale: "本轮上下文已过期",
  delivery_unavailable: "投递通道当前不可用",
  delivery_unknown: "投递结果未能确认",
  run_repeated_failure: "本轮运行反复失败",
  internal_failure: "内部处理失败",
};

export const automationFailureText = (code: string) => AUTOMATION_FAILURES[code] ?? "检查未能完成";
