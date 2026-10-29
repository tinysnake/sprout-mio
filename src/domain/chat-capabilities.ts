import { ChatError } from "./chat";
import type { ChatActor } from "./chat-actor";

/** 对话治理与发言的全部受检动作；新增动作必须同时补能力表与用例。 */
export const CHAT_ACTIONS = [
  "group_create",
  "group_dissolve",
  "member_add",
  "member_remove",
  "owner_change",
  "wake_policy_change",
  "message_send",
] as const;

export type ChatAction = (typeof CHAT_ACTIONS)[number];

/** 放行门槛：never 直接拒绝，member 只看身份类别，owner 还必须是当前所有者。 */
export type AccessLevel = "never" | "member" | "owner";

/**
 * 静态封闭能力表：Agent 在所有治理动作上都是 `never`。
 * 现有宿主把 `chat.createdBy` 当执行上下文的 userId 传给运行中的分身，
 * 「是不是人」只能由 `ChatActor` 的分支决定，不能靠 `ctx.userId` 猜。
 */
export const CHAT_CAPABILITIES: Record<ChatAction, { human: AccessLevel; agent: AccessLevel }> = {
  group_create: { human: "member", agent: "never" },
  group_dissolve: { human: "owner", agent: "never" },
  member_add: { human: "owner", agent: "never" },
  member_remove: { human: "owner", agent: "never" },
  owner_change: { human: "owner", agent: "never" },
  wake_policy_change: { human: "owner", agent: "never" },
  message_send: { human: "member", agent: "member" },
};

/**
 * 治理与发言权限的唯一判定点：不满足就抛 `ChatError("forbidden")`，由服务端边界映射成同名错误码。
 * `member` 档只判定身份类别，具体参与权仍由调用点从 `chat_effective_member` 读取；
 * `owner` 档在缺少归属事实时直接拒绝——没有所有者事实就没有所有权。
 */
export function assertChatCapability(
  action: ChatAction,
  actor: ChatActor,
  chat?: { readonly ownerKind: "human" | "agent"; readonly ownerId: string },
): void {
  const level = CHAT_CAPABILITIES[action][actor.kind];
  if (level === "never") throw new ChatError("forbidden", "当前身份不能执行该对话操作");
  if (level === "member") return;
  if (!chat) throw new ChatError("forbidden", "缺少对话归属信息，无法确认所有者");
  if (actor.kind !== "human" || chat.ownerKind !== "human" || chat.ownerId !== actor.userId)
    throw new ChatError("forbidden", "只有该对话的 Human 所有者可以执行该操作");
}
