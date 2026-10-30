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
  // 标题写入与成员、owner 同类：它改的是「这段对话是什么」，不是「谁在说话」。
  // 冻结形状只列了七项，验收 A03 证明八项之外的写入路径等于没有边界。
  "title_change",
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
  // Human 档是 member 而不是 owner：标题没有 `expectedRevision`，不属于 d15 的三类治理写入，
  // 现有行为是「能进这个 Project 的 Human 就能改名」，收成 owner 会改变 Human 行为。
  title_change: { human: "member", agent: "never" },
  message_send: { human: "member", agent: "member" },
};

/**
 * owner 档判定需要的事实：对话所有者，加上 `project.created_by`。
 * 领域层一次查齐后交给判定函数，调用方不许各自比 owner —— 两处各判一份就是两套真相。
 */
export type ChatOwnerFacts = {
  readonly ownerKind: "human" | "agent";
  readonly ownerId: string;
  /** 裁定 d6 的兜底事实，只对 `ownerKind === "agent"` 生效。 */
  readonly projectCreatedBy: string;
};

/**
 * 治理与发言权限的唯一判定点：不满足就抛 `ChatError("forbidden")`，由服务端边界映射成同名错误码。
 * `member` 档只判定身份类别，具体参与权仍由调用点从 `chat_effective_member` 读取。
 *
 * owner 档按裁定 d6 判：人类所有者本人，或对话所有者是 Agent 时由 Project 创建者的人类兜底。
 * 只认人类所有者的写法会让「Human 指定 Agent 为 owner」的群组永久冻结——没有任何人
 * 能改成员或换回 owner；只认 Project 创建者又会架空人类所有者。两种身份各有一条通路。
 */
export function assertChatCapability(
  action: ChatAction,
  actor: ChatActor,
  chat?: ChatOwnerFacts,
): void {
  const level = CHAT_CAPABILITIES[action][actor.kind];
  if (level === "never") throw new ChatError("forbidden", "当前身份不能执行该对话操作");
  if (level === "member") return;
  if (!chat) throw new ChatError("forbidden", "缺少对话归属信息，无法确认所有者");
  if (actor.kind !== "human") throw new ChatError("forbidden", "只有 Human 可以执行对话治理");
  const ownerIsAgent = chat.ownerKind === "agent";
  const allowed = ownerIsAgent
    ? chat.projectCreatedBy === actor.userId
    : chat.ownerId === actor.userId;
  if (!allowed) {
    throw new ChatError(
      "forbidden",
      ownerIsAgent
        ? "该对话的所有者是 Agent，只有 Project 创建者可以治理"
        : "只有该对话的 Human 所有者可以执行该操作",
    );
  }
}
