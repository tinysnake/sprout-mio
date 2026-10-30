import type { ChatKind } from "../../contracts/chat";
import { CHAT_CAPABILITIES, type AccessLevel } from "../../contracts/chat-capabilities";

export type GovernanceAction =
  | "member_add"
  | "member_remove"
  | "owner_change"
  | "wake_policy_change"
  | "group_dissolve"
  | "title_change";

export type GovernanceFacts = {
  kind: ChatKind;
  ownerKind: "human" | "agent";
  ownerId: string;
  actorKind: "human" | "agent";
  actorId: string;
  /** Agent owner 的兜底治理者；未知时按不可治理处理，不猜。 */
  projectCreatedBy?: string;
  /**
   * 领域层 `ChatOwnerFacts` 已算好的判定值。页面读到时直接采用，不再自己比较身份；
   * 缺省时才回落到浏览器内的同一张能力表（服务端仍是最终判定点）。
   */
  canChangeMembers?: boolean;
  canChangeOwner?: boolean;
  canChangeWakePolicy?: boolean;
  /** 领域层给出的只读原因；判定值缺省时用作治理段的说明。 */
  readOnlyReason?: string;
};

/**
 * 页面渲染读的就是领域层那张表：两侧各抄一份已经漂移过两次，
 * `title_change` 页面更严、`member_add` 改档后页面滞后。
 */
const ACTION_LEVEL: Record<GovernanceAction, { human: AccessLevel; agent: AccessLevel }> = {
  member_add: CHAT_CAPABILITIES.member_add,
  member_remove: CHAT_CAPABILITIES.member_remove,
  owner_change: CHAT_CAPABILITIES.owner_change,
  wake_policy_change: CHAT_CAPABILITIES.wake_policy_change,
  group_dissolve: CHAT_CAPABILITIES.group_dissolve,
  title_change: CHAT_CAPABILITIES.title_change,
};

/**
 * 页面按钮可用性只从冻结能力表推导：Agent 在所有治理动作上都是 never；member 档
 * 对 Human 直接放行（进入对话就已是有效成员），owner 档还要求当前 Human 是 owner
 * （或 Agent owner 时由 Project 创建者兜底）。领域层给出判定值时以判定值为准。
 * 这里只决定「是否渲染按钮」，真正的拒绝仍由领域层返回 forbidden。
 */
export function governanceAvailability(facts: GovernanceFacts): Record<GovernanceAction, boolean> {
  const result: Record<GovernanceAction, boolean> = {
    member_add: false,
    member_remove: false,
    owner_change: false,
    wake_policy_change: false,
    group_dissolve: false,
    title_change: false,
  };
  if (facts.kind !== "group") return result;
  const provided: Partial<Record<GovernanceAction, boolean | undefined>> = {
    member_add: facts.canChangeMembers,
    member_remove: facts.canChangeMembers,
    owner_change: facts.canChangeOwner,
    wake_policy_change: facts.canChangeWakePolicy,
  };
  const isOwner =
    facts.ownerKind === "agent"
      ? facts.projectCreatedBy !== undefined && facts.projectCreatedBy === facts.actorId
      : facts.ownerId === facts.actorId;
  for (const action of Object.keys(ACTION_LEVEL) as GovernanceAction[]) {
    const given = provided[action];
    if (given !== undefined) {
      result[action] = given;
      continue;
    }
    const level = ACTION_LEVEL[action][facts.actorKind];
    if (level === "never") continue;
    result[action] = level === "owner" ? isOwner : true;
  }
  return result;
}

/**
 * 治理段的判定说明：按当前判定结果分情况写，不写死「只有 owner 能改成员」。
 * 成员治理放宽到 Human 成员后，第一句自动变成「人类成员都能调整成员」。
 */
export function governanceNote(facts: GovernanceFacts): string {
  if (facts.kind === "public_channel")
    return "公共频道 Owner 固定为 Project 创建者，成员跟随 Project 自动同步。";
  if (facts.kind !== "group") return "";
  const actions = governanceAvailability(facts);
  if (!actions.member_add)
    return `${facts.readOnlyReason ?? "当前身份不能修改成员与 Owner。"}Agent 不参与治理。`;
  return actions.owner_change
    ? "Human 成员都能调整成员；Owner 变更需要当前 Human owner。Agent 不参与治理。"
    : "Human 成员都能调整成员；当前身份不能变更 Owner。Agent 不参与治理。";
}

/**
 * 右栏治理段的重命名入口：普通 Group 的当前 Human 成员都能看到，与领域表
 * `title_change` 的 member 档一致。DM 的标题入口保留在消息头部（P4b 形状），
 * Public Channel 的治理按钮一律不渲染，因此这两类对话在这里直接返回 false。
 */
export function canRenameChat(facts: GovernanceFacts): boolean {
  return governanceAvailability(facts).title_change;
}
