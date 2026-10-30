import type { ChatKind, ChatOwnerFacts } from "../contracts/chat";
import { CHAT_CAPABILITIES, type ChatAction } from "../contracts/chat-capabilities";
import { ChatError } from "./chat";
import type { ChatActor } from "./chat-actor";

export {
  CHAT_ACTIONS,
  CHAT_CAPABILITIES,
  type AccessLevel,
  type ChatAction,
} from "../contracts/chat-capabilities";

/**
 * 判定所需的最小事实：对话种类、对话所有者，加上 `project.created_by`（裁定 d6 的兜底来源）。
 * 领域层一次查齐后交进来，调用方不许各自比 owner —— 两处各判一份就是两套真相。
 */
export type ChatGovernanceScope = {
  readonly kind: ChatKind;
  readonly ownerKind: "human" | "agent";
  readonly ownerId: string;
  /** 只对 `ownerKind === "agent"` 生效的人类兜底者。 */
  readonly projectCreatedBy?: string;
};

function actorIdOf(actor: ChatActor): string {
  return actor.kind === "human" ? actor.userId : actor.agentProfileId;
}

/**
 * 能力表的唯一判定：`never` 直接拒；`member` 只看身份类别（参与权由调用点按
 * `chat_effective_member` 补）；`owner` 档按裁定 d6 —— 人类所有者本人，或对话所有者是 Agent 时
 * 由 Project 创建者的人类兜底。只认人类所有者会让「Human 指定 Agent 为 owner」的群组永久冻结，
 * 只认 Project 创建者又会架空人类所有者，两种身份各有一条通路。
 */
function decide(
  action: ChatAction,
  scope: ChatGovernanceScope,
  actorKind: "human" | "agent",
  actorId: string,
): boolean {
  const level = CHAT_CAPABILITIES[action][actorKind];
  if (level === "never") return false;
  if (level === "member") return true;
  if (actorKind !== "human") return false;
  return scope.ownerKind === "agent"
    ? scope.projectCreatedBy === actorId
    : scope.ownerId === actorId;
}

/** 只读说明与拒绝文案同源：领域抛错与页面展示读同一句，不各写一份。 */
function denialReason(scope: ChatGovernanceScope, actorKind: "human" | "agent"): string {
  if (actorKind !== "human") return "Agent 不参与对话治理";
  return scope.ownerKind === "agent"
    ? "该对话的所有者是 Agent，只有 Project 创建者可以治理"
    : "只有该对话的 Human 所有者可以执行该操作";
}

/**
 * 会话的治理事实（裁定 d45）：能力表与 d6 的 owner 判定在这里一次算完，页面只读。
 * 四个 `can*` 只表达「右栏这个入口该不该出现」，真正的拒绝仍由领域层的
 * `assertChatCapability` 给出；两者读的是同一个 `decide`。
 */
export function chatGovernanceFacts(scope: ChatGovernanceScope, actor: ChatActor): ChatOwnerFacts {
  const actorId = actorIdOf(actor);
  // 成员与 Owner 治理只对普通 Group 生效（频道成员是 Project 成员的派生事实，DM 成员固定）。
  const group = scope.kind === "group";
  const can = (action: ChatAction) => group && decide(action, scope, actor.kind, actorId);
  const canChangeMembers = can("member_add") && can("member_remove");
  const canChangeOwner = can("owner_change");
  const canChangeWakePolicy = can("wake_policy_change");
  const reason = group && !canChangeMembers ? denialReason(scope, actor.kind) : undefined;
  return {
    ownerKind: scope.ownerKind,
    ownerId: scope.ownerId,
    actorKind: actor.kind,
    actorId,
    ...(scope.projectCreatedBy === undefined ? {} : { projectCreatedBy: scope.projectCreatedBy }),
    canChangeMembers,
    canChangeOwner,
    canChangeWakePolicy,
    canRenameTitle: can("title_change"),
    ...(reason === undefined ? {} : { readOnlyReason: reason }),
  };
}

/**
 * 治理与发言权限的唯一执行点：不满足就抛 `ChatError("forbidden")`，由服务端边界映射成同名错误码。
 * `member` 档只判定身份类别，具体参与权仍由调用点从 `chat_effective_member` 读取。
 */
export function assertChatCapability(
  action: ChatAction,
  actor: ChatActor,
  scope?: ChatGovernanceScope,
): void {
  const level = CHAT_CAPABILITIES[action][actor.kind];
  if (level === "never") throw new ChatError("forbidden", "当前身份不能执行该对话操作");
  if (level === "member") return;
  if (!scope) throw new ChatError("forbidden", "缺少对话归属信息，无法确认所有者");
  const facts = chatGovernanceFacts(scope, actor);
  const allowed =
    action === "owner_change"
      ? facts.canChangeOwner
      : action === "wake_policy_change" || action === "group_dissolve"
        ? facts.canChangeWakePolicy
        : facts.canChangeMembers;
  if (!allowed)
    throw new ChatError("forbidden", facts.readOnlyReason ?? denialReason(scope, actor.kind));
}
