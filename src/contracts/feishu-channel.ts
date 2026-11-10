import { z } from "zod";
import type { ChannelOutcome } from "./channel";
import { chatIdInput } from "./chat";
import { projectIdInput } from "./project";
import type { VerifiedFeishuIdentity } from "./feishu";

/**
 * 传输层配置只在服务端解析：凭据不进浏览器、不进卡片、不进日志。
 * `enabled` 为 false 时进程行为与没有 Feishu 能力时完全一致。
 */
export type FeishuTransportConfig = Readonly<{
  appId: string;
  appSecret: string;
  /** 协议 origin，例如 https://open.feishu.cn；测试注入回环 http origin。 */
  origin: string;
  enabled: boolean;
}>;

export type FeishuConnectionPhase =
  | "disabled"
  | "starting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "stopped";

/**
 * 诊断快照。`generation` 是应用内单调递增的 owner 代号：每次 start 自增，stop 也自增，
 * 旧代的回调一律作废。`error` 只放安全分类码，不放凭据或响应正文。
 */
export type FeishuConnectionSnapshot = Readonly<{
  appId: string | null;
  phase: FeishuConnectionPhase;
  generation: number;
  epochId: string | null;
  error: string | null;
  changedAtMs: number;
}>;

/**
 * 已通过边界解析的入站私聊文本。只有 p2p、text、人类发送者、可信 app/tenant/open_id
 * 与可信 create_time 才能走到这里；其余输入在边界就被丢弃。
 */
export type NormalizedFeishuMessage = Readonly<{
  identity: VerifiedFeishuIdentity;
  messageId: string;
  chatId: string;
  chatType: "p2p";
  messageType: "text";
  text: string;
  createdAtMs: number;
  rawEventId: string | null;
}>;

/** 卡片回调里唯一可信的路由材料：操作者身份 + 不透明 token。 */
export type NormalizedFeishuCardAction = Readonly<{
  identity: VerifiedFeishuIdentity;
  token: string;
  rawEventId: string | null;
}>;

/** 卡片回调必须立即应答；返回值会被 SDK 编码成 base64 JSON 作为 ACK。 */
export type FeishuCardAck = Readonly<{
  toast?: Readonly<{ type: "success" | "error" | "info"; content: string }>;
}>;

/**
 * prepare() 的产物：已经拿到 token、拼好请求体的一次发送。
 * token 只在 headers 里，`requestTag` 只用于日志关联，不含 token、不含正文。
 */
export type FeishuPreparedEmission = Readonly<{
  deliveryId: string;
  requestTag: string;
  request: Readonly<{
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    timeoutMs: number;
  }>;
}>;

/** begin() 的返回：同步发起了恰好一个请求，完成结果稍后给出。 */
export type FeishuInitiatedEmission = Readonly<{
  initiated: true;
  completion: Promise<ChannelOutcome>;
}>;

/**
 * 未来绑定页消费的 DTO。它只描述服务端已确认的事实：选中的 Assistant 私聊、
 * 连接状态、挑战过期时间与「Human 还需确认」状态；不含 token 摘要或平台凭据。
 */
export type FeishuBindingView = Readonly<{
  adapter: "feishu";
  configured: boolean;
  connection: Readonly<{
    phase: FeishuConnectionPhase;
    generation: number;
    epochId: string | null;
  }>;
  binding: Readonly<{
    revision: number;
    bound: boolean;
    target: Readonly<{
      projectId: string;
      chatId: string;
      agentName: string | null;
      chatTitle: string | null;
    }> | null;
  }>;
  challenge: Readonly<{ code: string; expiresAtMs: number }> | null;
  humanNeedsConfirmation: boolean;
}>;

/** 绑定页可选目标：当前 Human 在该 Project 拥有的助理私聊。 */
export type FeishuTargetOption = Readonly<{
  chatId: string;
  chatTitle: string | null;
  agentName: string;
}>;

export type FeishuTargetsView = Readonly<{
  targets: FeishuTargetOption[];
}>;

/** 绑定页 RPC 的输入：Project 来自会话上下文，Human 身份永远由会话决定，不由调用方提交。 */
export const feishuBindingInput = projectIdInput;

export const feishuExpectedRevision = z.number().int().nonnegative();

export const feishuStartChallengeInput = projectIdInput.merge(chatIdInput).extend({
  expectedRevision: feishuExpectedRevision,
});

export const feishuSwitchTargetInput = feishuStartChallengeInput;

export const feishuRevisionInput = projectIdInput.extend({
  expectedRevision: feishuExpectedRevision,
});

/** 发起/换绑后一次性展示的挑战码；服务端只存摘要。 */
export type FeishuChallengeView = Readonly<{
  challenge: string;
  expiresAtMs: number;
  revision: number;
  binding: FeishuBindingView;
}>;
