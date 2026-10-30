import { describe, expect, it } from "vite-plus/test";
import { governanceAvailability } from "../src/components/chat/chat-governance";
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

describe("chat governance affordance", () => {
  it.each(GOVERNANCE_ACTIONS)("%s 与领域能力表对当前 Owner 的判断一致", (action) => {
    expect(governanceAvailability(facts)[action]).toBe(CHAT_CAPABILITIES[action].human === "owner");
  });

  it.each(GOVERNANCE_ACTIONS)("%s 对非 Owner 的 Human 不渲染", (action) => {
    expect(governanceAvailability({ ...facts, actorId: "usr_other" })[action]).toBe(false);
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
});
