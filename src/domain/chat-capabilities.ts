import { ChatError } from "./chat";
import type { ChatActor } from "./chat-actor";

export {
  CHAT_ACTIONS,
  CHAT_CAPABILITIES,
  type AccessLevel,
  type ChatAction,
} from "../contracts/chat-capabilities";

import { CHAT_CAPABILITIES, type ChatAction } from "../contracts/chat-capabilities";

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
