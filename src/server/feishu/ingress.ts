import { z } from "zod";
import type {
  FeishuCardAck,
  NormalizedFeishuCardAction,
  NormalizedFeishuMessage,
} from "../../contracts/feishu-channel";
import type {
  FeishuAdmission,
  FeishuAdmissionScope,
  FeishuEpoch,
  VerifiedFeishuEvent,
  VerifiedFeishuIdentity,
} from "../../contracts/feishu";
import type { ChannelActionResult } from "../../contracts/channel";
import type { FeishuDispatcherHandlers } from "./owner";

const MESSAGE_EVENT = "im.message.receive_v1";
const CARD_EVENT = "card.action.trigger";

/** 平台字段的可信边界：多字段照常放过，缺字段或类型不对就整条丢弃。 */
function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const jsonText = z.string().transform((value, ctx) => {
  try {
    const parsed: unknown = JSON.parse(value);
    const object = plainObject(parsed);
    if (!object) {
      ctx.addIssue({ code: "custom", message: "content must be a JSON object" });
      return z.NEVER;
    }
    return object;
  } catch {
    ctx.addIssue({ code: "custom", message: "content must be JSON" });
    return z.NEVER;
  }
});

const messagePayloadSchema = z.object({
  app_id: z.string().min(1),
  tenant_key: z.string().min(1),
  event_id: z.string().min(1).optional(),
  create_time: z.string().optional(),
  sender: z.object({
    sender_id: z
      .object({
        open_id: z.string().min(1).optional(),
        union_id: z.string().min(1).optional(),
        user_id: z.string().min(1).optional(),
      })
      .optional(),
    sender_type: z.string().min(1),
    tenant_key: z.string().optional(),
  }),
  message: z.object({
    message_id: z.string().min(1),
    chat_id: z.string().min(1),
    chat_type: z.string().min(1),
    message_type: z.string().min(1),
    content: jsonText,
    create_time: z.string().optional(),
  }),
});

const cardPayloadSchema = z.object({
  app_id: z.string().min(1),
  tenant_key: z.string().min(1),
  event_id: z.string().min(1).optional(),
  operator: z.object({
    open_id: z.string().min(1),
    tenant_key: z.string().optional(),
  }),
  action: z.object({ value: z.unknown() }),
});

const MILLIS = /^\d{13}$/;
const MAX_TEXT_CHARS = 20_000;

/**
 * SDK 把 v2 事件压平成 `{...header, ...event}`；直接把原始信封交给本模块时
 * 也按同样规则压平，因此只有一份解析路径。
 */
function flatten(payload: unknown): Record<string, unknown> | null {
  const object = plainObject(payload);
  if (!object) return null;
  const header = plainObject(object.header);
  const event = plainObject(object.event);
  if (!header && !event) return object;
  return { ...object, ...header, ...event };
}

function trustedMillis(value: unknown): number | null {
  if (typeof value !== "string" || !MILLIS.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 只放行「p2p + text + 人类发送者 + 可信 app/tenant/open_id + 可信毫秒时间」。
 * 群聊、机器人自己、其他机器人、非文本一律返回 null：不构造原生消息，也不猜内容。
 */
export function parseFeishuMessageEvent(
  payload: unknown,
  appId: string,
): NormalizedFeishuMessage | null {
  const parsed = messagePayloadSchema.safeParse(flatten(payload));
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  if (parsed.data.app_id !== appId) return null;
  if (message.chat_type !== "p2p" || message.message_type !== "text") return null;
  // sender_type "user" 是人类；"app" 是应用（含本机器人），其他类型同样拒绝。
  if (sender.sender_type !== "user") return null;
  const openId = sender.sender_id?.open_id;
  if (!openId) return null;
  if (sender.tenant_key && sender.tenant_key !== parsed.data.tenant_key) return null;
  const createdAtMs = trustedMillis(message.create_time) ?? trustedMillis(parsed.data.create_time);
  if (createdAtMs === null) return null;
  const text = message.content.text;
  if (typeof text !== "string") return null;
  const body = text.trim();
  if (body.length === 0 || body.length > MAX_TEXT_CHARS) return null;
  return {
    identity: {
      appId: parsed.data.app_id,
      tenantKey: parsed.data.tenant_key,
      openId,
    } as VerifiedFeishuIdentity,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: "p2p",
    messageType: "text",
    text: body,
    createdAtMs,
    rawEventId: parsed.data.event_id ?? null,
  };
}

/** 卡片只认操作者身份与不透明 token；`event.token` 是回调校验 token，不是授权凭据。 */
export function parseFeishuCardAction(
  payload: unknown,
  appId: string,
): NormalizedFeishuCardAction | null {
  const parsed = cardPayloadSchema.safeParse(flatten(payload));
  if (!parsed.success) return null;
  if (parsed.data.app_id !== appId) return null;
  const operator = parsed.data.operator;
  if (operator.tenant_key && operator.tenant_key !== parsed.data.tenant_key) return null;
  const rawValue = parsed.data.action.value;
  const value =
    typeof rawValue === "string" ? plainObject(safeJson(rawValue)) : plainObject(rawValue);
  const token = value?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
  return {
    identity: {
      appId: parsed.data.app_id,
      tenantKey: parsed.data.tenant_key,
      openId: operator.open_id,
    } as VerifiedFeishuIdentity,
    token,
    rawEventId: parsed.data.event_id ?? null,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function verifiedEventOf(message: NormalizedFeishuMessage): VerifiedFeishuEvent {
  return {
    identity: message.identity,
    messageId: message.messageId,
    chatType: message.chatType,
    messageType: message.messageType,
    body: message.text,
    createdAtMs: message.createdAtMs,
  } as VerifiedFeishuEvent;
}

/** 绑定错误里只有「这不是挑战码」可以降级为普通文本；其余一律丢弃。 */
function isInvalidChallenge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "invalid_challenge"
  );
}

const CARD_ACK = {
  handled: { toast: { type: "success", content: "已处理，结果见 Web 对话" } },
  expired: { toast: { type: "error", content: "这个操作已失效，请到 Web 查看" } },
} as const satisfies Record<string, FeishuCardAck>;

export type FeishuIngressDependencies = Readonly<{
  appId: string;
  currentEpoch: () => FeishuEpoch | null;
  captureScope: (
    identity: VerifiedFeishuIdentity,
    epoch: FeishuEpoch,
  ) => FeishuAdmissionScope | undefined;
  admitText: (
    event: VerifiedFeishuEvent,
    scope: FeishuAdmissionScope,
    requestId: string,
  ) => FeishuAdmission;
  finishChallenge: (opaque: string, identity: VerifiedFeishuIdentity, requestId: string) => unknown;
  consumeAction: (
    identity: VerifiedFeishuIdentity,
    scope: FeishuAdmissionScope,
    token: string,
    now: Date,
  ) => ChannelActionResult;
  now?: () => Date;
  requestId: () => string;
  onDiagnostic?: (input: Readonly<{ event: string; code: string }>) => void;
}>;

/**
 * 两个事件共用一个 owner、一道代数围栏、一个当前 epoch。ACK 只表示「收到了」：
 * 返回 {} 时平台不会再推，但接受与否由领域层的结果决定。
 */
export function createFeishuIngressHandlers(
  deps: FeishuIngressDependencies,
): FeishuDispatcherHandlers {
  const now = deps.now ?? (() => new Date());
  const diagnostic = (event: string, code: string) => {
    try {
      deps.onDiagnostic?.({ event, code });
    } catch {
      // 诊断写不进去不影响应答。
    }
  };

  return {
    [MESSAGE_EVENT]: (payload) => {
      const message = parseFeishuMessageEvent(payload, deps.appId);
      if (!message) {
        diagnostic("feishu.ingress_ignored", "unsupported_message");
        return {};
      }
      // 没有开着的 epoch 说明这条输入属于断线期间：拒绝且不回放。
      const epoch = deps.currentEpoch();
      if (!epoch) {
        diagnostic("feishu.ingress_ignored", "no_epoch");
        return {};
      }
      // 挑战码优先：绑定成功不再造原生消息，失败也不把码当正文发出去。
      try {
        deps.finishChallenge(message.text, message.identity, deps.requestId());
        diagnostic("feishu.identity_bound", "bound");
        return {};
      } catch (error) {
        if (!isInvalidChallenge(error)) {
          diagnostic("feishu.binding_rejected", "binding_error");
          return {};
        }
      }
      const scope = deps.captureScope(message.identity, epoch);
      if (!scope) {
        diagnostic("feishu.ingress_ignored", "no_route");
        return {};
      }
      const admission = deps.admitText(verifiedEventOf(message), scope, deps.requestId());
      diagnostic(
        admission.status === "accepted" ? "feishu.admission_accepted" : "feishu.admission_rejected",
        admission.status === "accepted"
          ? admission.duplicate
            ? "duplicate"
            : "accepted"
          : admission.reason,
      );
      return {};
    },
    [CARD_EVENT]: (payload) => {
      const action = parseFeishuCardAction(payload, deps.appId);
      if (!action) {
        diagnostic("feishu.card_ignored", "unsupported_action");
        return CARD_ACK.expired;
      }
      const epoch = deps.currentEpoch();
      if (!epoch) {
        diagnostic("feishu.card_ignored", "no_epoch");
        return CARD_ACK.expired;
      }
      const scope = deps.captureScope(action.identity, epoch);
      if (!scope) {
        diagnostic("feishu.card_ignored", "no_route");
        return CARD_ACK.expired;
      }
      try {
        deps.consumeAction(action.identity, scope, action.token, now());
      } catch {
        // 过期、被改过的 token、身份不再匹配都走同一条应答：不回显任何结果。
        diagnostic("feishu.card_rejected", "ineligible");
        return CARD_ACK.expired;
      }
      diagnostic("feishu.card_consumed", "consumed");
      return CARD_ACK.handled;
    },
  };
}

export const FEISHU_MESSAGE_EVENT = MESSAGE_EVENT;
export const FEISHU_CARD_EVENT = CARD_EVENT;
