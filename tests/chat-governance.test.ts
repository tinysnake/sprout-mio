import { describe, expect, it } from "vite-plus/test";
import { canRenameChat, governanceAvailability } from "../src/components/chat/chat-governance";
import { CHAT_CAPABILITIES } from "../src/domain/chat-capabilities";

const GOVERNANCE_ACTIONS = [
  "group_dissolve",
  "member_add",
  "member_remove",
  "owner_change",
  "wake_policy_change",
] as const;

const facts = {
  kind: "group" as const,
  ownerKind: "human" as const,
  ownerId: "usr_owner",
  actorKind: "human" as const,
  actorId: "usr_owner",
  projectCreatedBy: "usr_owner",
};

/** 领域表是唯一真值：member 档对 Human 直接放行，owner 档还要求是当前所有者。 */
function expected(action: (typeof GOVERNANCE_ACTIONS)[number], owner: boolean) {
  const level = CHAT_CAPABILITIES[action].human;
  if (level === "never") return false;
  return level === "member" ? true : owner;
}

describe("chat governance affordance", () => {
  it.each(GOVERNANCE_ACTIONS)("%s 与领域能力表对当前 Owner 的判断一致", (action) => {
    expect(governanceAvailability(facts)[action]).toBe(expected(action, true));
  });

  it.each(GOVERNANCE_ACTIONS)("%s 对非 Owner 的 Human 按能力档位判定", (action) => {
    expect(governanceAvailability({ ...facts, actorId: "usr_other" })[action]).toBe(
      expected(action, false),
    );
  });

  // 成员增删对任何 Human 成员开放（领域表 165bc58），页面照抄同一档位。
  it("成员治理对非 Owner 的 Human 成员同样渲染", () => {
    const other = governanceAvailability({ ...facts, actorId: "usr_other" });
    expect(other.member_add).toBe(true);
    expect(other.member_remove).toBe(true);
    expect(other.owner_change).toBe(false);
    expect(other.wake_policy_change).toBe(false);
  });

  it.each(GOVERNANCE_ACTIONS)("%s 对 Agent 永不渲染", (action) => {
    expect(
      governanceAvailability({ ...facts, actorKind: "agent", actorId: "agf_agent" })[action],
    ).toBe(false);
  });

  it("非群组没有治理动作", () => {
    const dm = governanceAvailability({ ...facts, kind: "dm" });
    expect(Object.values(dm).some(Boolean)).toBe(false);
  });

  // 页面不再比领域表更严：`title_change` 是 member 档，普通群的 Human 成员都能看到入口，
  // 隐藏一个 API 允许的动作只会让人以为不能改。服务端仍是最终判定点。
  it("重命名入口对普通群的 Human 成员渲染", () => {
    expect(canRenameChat(facts)).toBe(true);
    expect(canRenameChat({ ...facts, actorId: "usr_other" })).toBe(true);
    expect(canRenameChat({ ...facts, kind: "dm" })).toBe(false);
    expect(canRenameChat({ ...facts, kind: "public_channel" })).toBe(false);
    expect(canRenameChat({ ...facts, actorKind: "agent", actorId: "agf_agent" })).toBe(false);
    expect(CHAT_CAPABILITIES.title_change.human).toBe("member");
  });
});
