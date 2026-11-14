import { describe, expect, it } from "vite-plus/test";

// 领域层判定要装载 ChatError 与能力表：先把连接指到内存库，本文件不执行任何查询。
process.env.DATABASE_URL ??= ":memory:";

const { chatGovernanceFacts, CHAT_CAPABILITIES } = await import("../src/domain/chat-capabilities");
const { governanceNote } = await import("../src/components/chat/chat-governance");
import type { ChatGovernanceScope } from "../src/domain/chat-capabilities";
import type { ChatActor } from "../src/domain/chat-actor";

const ctx = { userId: "usr_owner", requestId: "req_test" };
const human = (userId: string): ChatActor => ({ kind: "human", userId, ctx });
const agent = (agentProfileId: string): ChatActor => ({
  kind: "agent",
  agentProfileId,
  instanceId: "ins_1",
  runId: "run_1",
  ctx,
});

const crew: ChatGovernanceScope = {
  kind: "crew",
  ownerKind: "human",
  ownerId: "usr_owner",
  projectCreatedBy: "usr_owner",
};
const factsFor = (scope: ChatGovernanceScope, actor: ChatActor) =>
  chatGovernanceFacts(scope, actor);

describe("chat 治理事实（领域算、页面只读）", () => {
  it("Human owner 拿全部治理入口，成员档动作对任何 Human 成员都开", () => {
    const facts = factsFor(crew, human("usr_owner"));
    expect(facts.canChangeMembers).toBe(true);
    expect(facts.canChangeLead).toBe(true);
    expect(facts.canRenameTitle).toBe(true);
    expect(facts.readOnlyReason).toBeUndefined();
    expect(facts.actorKind).toBe("human");
    expect(facts.actorId).toBe("usr_owner");
  });

  it("非 owner 的 Human 成员能改成员、不能换 lead", () => {
    const facts = factsFor(crew, human("usr_other"));
    expect(facts.canChangeMembers).toBe(true);
    expect(facts.canChangeLead).toBe(false);
    expect(facts.canRenameTitle).toBe(true);
  });

  it("Agent 当 owner 时，Project 创建者的人类仍可更改 lead", () => {
    const agentOwner: ChatGovernanceScope = {
      kind: "crew",
      ownerKind: "agent",
      ownerId: "agp_1",
      projectCreatedBy: "usr_owner",
    };
    const creator = factsFor(agentOwner, human("usr_owner"));
    expect(creator.canChangeLead).toBe(true);
    expect(creator.canChangeMembers).toBe(true);
    expect(creator.projectCreatedBy).toBe("usr_owner");

    const other = factsFor(agentOwner, human("usr_other"));
    expect(other.canChangeLead).toBe(false);
    expect(other.readOnlyReason).toBeUndefined();
  });

  it("Agent 在所有治理动作上都拿到 false，并被写明不参与治理", () => {
    const facts = factsFor(crew, agent("agp_1"));
    expect(facts.canChangeMembers).toBe(false);
    expect(facts.canChangeLead).toBe(false);
    expect(facts.canRenameTitle).toBe(false);
    expect(facts.readOnlyReason).toContain("Agent");
  });

  it("DM 没有成员与 lead 治理入口，但可以改自己的标题", () => {
    const dm = factsFor({ ...crew, kind: "dm" }, human("usr_member"));
    expect(dm.canChangeMembers).toBe(false);
    expect(dm.canChangeLead).toBe(false);
    expect(dm.canRenameTitle).toBe(true);
  });

  it("判定值与能力表的档位同源：member 档对 Human 开，owner 档看归属", () => {
    expect(CHAT_CAPABILITIES.member_add.human).toBe("member");
    expect(CHAT_CAPABILITIES.lead_change.human).toBe("owner");
    expect(CHAT_CAPABILITIES.title_change.human).toBe("member");
    expect(CHAT_CAPABILITIES.member_add.agent).toBe("never");
  });
});

describe("治理段文案读 facts，不再自己判身份", () => {
  it("能换 lead 的治理者看到条件是当前 Human owner", () => {
    const facts = factsFor(
      { kind: "crew", ownerKind: "agent", ownerId: "agp_1", projectCreatedBy: "usr_owner" },
      human("usr_owner"),
    );
    expect(governanceNote("crew", facts)).toContain("lead 变更需要当前 Human owner");
  });

  it("非兜底者看到的是「当前身份不能变更 lead」", () => {
    const facts = factsFor(
      { kind: "crew", ownerKind: "agent", ownerId: "agp_1", projectCreatedBy: "usr_owner" },
      human("usr_other"),
    );
    const note = governanceNote("crew", facts);
    expect(note).toContain("当前身份不能变更 lead");
    expect(note).toContain("Agent 不参与治理");
  });

  it("Agent 行动者看到领域给的只读原因", () => {
    const note = governanceNote("crew", factsFor(crew, agent("agp_1")));
    expect(note).toContain("Agent 不参与治理");
  });

  it("DM 没有治理文案", () => {
    expect(governanceNote("dm", factsFor({ ...crew, kind: "dm" }, human("usr_owner")))).toBe("");
  });
});
