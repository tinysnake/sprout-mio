import type { FeishuConnectionPhase } from "../../contracts/feishu-channel";
import type { AppError } from "../../contracts/result";

export const FEISHU_UNCONFIGURED_COPY = "先在上面填写 App ID 与 App Secret，保存后再绑定飞书账号。";

const PHASE_LABELS: Readonly<Record<FeishuConnectionPhase, string>> = {
  disabled: "未启用",
  starting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  failed: "失败",
  stopped: "未启用",
};

export function connectionPhaseLabel(phase: FeishuConnectionPhase): string {
  return PHASE_LABELS[phase];
}

export function targetLabel(target: {
  chatTitle: string | null;
  agentName: string | null;
}): string {
  if (target.chatTitle) return target.chatTitle;
  return target.agentName ? `${target.agentName} 的助理私聊` : "未命名助理私聊";
}

export function targetOptionLabel(target: { chatTitle: string | null; agentName: string }): string {
  return target.chatTitle
    ? `${target.agentName} · ${target.chatTitle}`
    : `${target.agentName} 的助理私聊`;
}

export function challengeRemainingLabel(expiresAtMs: number, nowMs: number): string {
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return "确认码已过期";
  return `剩余约 ${Math.ceil(remaining / 60_000)} 分钟`;
}

/** 失败翻译保留服务端的具体原因，只补上页面已经执行的动作（重新读取状态）。 */
export function feishuFailureText(error: AppError): string {
  switch (error.code) {
    case "forbidden":
      return "只有 Human 可以绑定飞书私聊。";
    case "not_found":
      return "Project 不存在，或当前账号无权访问。";
    case "unauthorized":
      return "登录状态已失效，请重新登录后再试。";
    case "validation_failed":
      return "请求参数无效，请刷新页面后重试。";
    case "conflict":
      return `${error.message}。绑定状态已重新读取，请按最新状态操作。`;
    case "too_many_requests":
      return "操作过于频繁，请稍后再试。";
    default:
      return error.message;
  }
}
