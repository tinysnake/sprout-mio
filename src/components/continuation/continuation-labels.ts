export const CONTINUATION_SOURCES = {
  message: "消息触发",
  task_periodic: "周期检查",
};

export const CONTINUATION_RECIPIENT_DECISIONS = {
  yes: "建议接续",
  no: "无需接续",
  unknown: "无法判定",
};

export const CONTINUATION_DELIVERY_STATES = {
  pending: "等待投递",
  bound: "已绑定运行",
  admitted: "已准入",
  delivered: "已确认送达",
  attention: "需要处理",
  canceled: "已取消",
  presented: "已展示提醒",
  stale: "投递已失效",
};

export const CONTINUATION_MODES = {
  enabled: "对话接续已启用",
  off: "对话接续已关闭",
};

export const CONTINUATION_DECISIONS = {
  continue: "建议接续",
  do_not_continue: "本轮无需接续",
  indeterminate: "未能得出可靠结论",
};

export const CONTINUATION_STATES = {
  pending: "等待检查",
  claimed: "正在检查",
  retry_wait: "检查失败 · 等待重试",
  decided: "已完成检查",
  attention: "检查失败 · 需要处理",
  stale: "检查已失效",
  canceled: "检查已取消",
};

export const continuationTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";

/** 耗时按人读的尺度取舍：秒以下不留小数，超过一分钟改说分秒。 */
export const continuationDuration = (ms: number) => {
  if (ms < 1_000) return "不足 1 秒";
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

/** token 数只给量级：精确到个位对「这次花了多少」没有帮助。 */
export const continuationTokens = (tokens: number) =>
  tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(1)}k`;

/** 内部失败码只说给人听的话，码本身留在 data-error-code 上给门禁与排查用。 */
export const CONTINUATION_FAILURES: Record<string, string> = {
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

export const continuationFailureText = (code: string) =>
  CONTINUATION_FAILURES[code] ?? "检查未能完成";

/** 尝试记录里两种码混在一起：失败码翻译，跳过原因本身就是人话。 */
export const continuationAttemptText = (code: string) => CONTINUATION_FAILURES[code] ?? code;
