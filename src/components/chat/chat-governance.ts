import type { ChatKind } from "../../contracts/chat";

export type GovernanceAction =
  | "member_add"
  | "member_remove"
  | "owner_change"
  | "wake_policy_change"
  | "group_dissolve";

export type GovernanceFacts = {
  kind: ChatKind;
  ownerKind: "human" | "agent";
  ownerId: string;
  actorKind: "human" | "agent";
  actorId: string;
  /** Agent owner 的兜底治理者；未知时按不可治理处理，不猜。 */
  projectCreatedBy?: string;
};

const ACTION_LEVEL: Record<GovernanceAction, { human: "never" | "owner"; agent: "never" }> = {
  // 与 src/domain/chat-capabilities.ts 的 CHAT_CAPABILITIES 同值；页面只消费规则，
  // 不在浏览器 bundle 里引入带数据库依赖的领域模块。服务端仍是最终判定点。
  member_add: { human: "owner", agent: "never" },
  member_remove: { human: "owner", agent: "never" },
  owner_change: { human: "owner", agent: "never" },
  wake_policy_change: { human: "owner", agent: "never" },
  group_dissolve: { human: "owner", agent: "never" },
};

/**
 * 页面按钮可用性只从冻结能力表推导：Agent 在所有治理动作上都是 never，
 * 普通 Group 还要求当前 Human 是 owner（或 Agent owner 时由 Project 创建者兜底）。
 * 这里只决定「是否渲染按钮」，真正的拒绝仍由领域层返回 forbidden。
 */
export function governanceAvailability(facts: GovernanceFacts): Record<GovernanceAction, boolean> {
  const result: Record<GovernanceAction, boolean> = {
    member_add: false,
    member_remove: false,
    owner_change: false,
    wake_policy_change: false,
    group_dissolve: false,
  };
  if (facts.kind !== "group") return result;
  const isOwner =
    facts.ownerKind === "agent"
      ? facts.projectCreatedBy !== undefined && facts.projectCreatedBy === facts.actorId
      : facts.ownerId === facts.actorId;
  for (const action of Object.keys(ACTION_LEVEL) as GovernanceAction[]) {
    const level = ACTION_LEVEL[action][facts.actorKind];
    if (level === "never") continue;
    result[action] = level === "owner" ? isOwner : true;
  }
  return result;
}
