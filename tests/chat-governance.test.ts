import { describe, expect, it } from "vite-plus/test";

// 领域层判定要装载 ChatError 与能力表：先把连接指到内存库，本文件不执行任何查询。
process.env.DATABASE_URL ??= ":memory:";

const { chatGovernanceFacts } = await import("../src/domain/chat-capabilities");
const { governanceNote } = await import("../src/components/chat/chat-governance");
const { CHAT_CAPABILITIES } = await import("../src/domain/chat-capabilities");
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

const group: ChatGovernanceScope = {
  kind: "group",
  ownerKind: "human",
  ownerId: "usr_owner",
  projectCreatedBy: "usr_owner",
};
const factsFor = (scope: ChatGovernanceScope, actor: ChatActor) =>
  chatGovernanceFacts(scope, actor);

describe("chat 治理事实（领域算、页面只读）", () => {
  it("Human owner 拿全部治理入口，成员档动作对任何 Human 成员都开", () => {
    const facts = factsFor(group, human("usr_owner"));
    expect(facts.canChangeMembers).toBe(true);
    expect(facts.canChangeOwner).toBe(true);
    expect(facts.canChangeWakePolicy).toBe(true);
    expect(facts.canRenameTitle).toBe(true);
    expect(facts.readOnlyReason).toBeUndefined();
    expect(facts.actorKind).toBe("human");
    expect(facts.actorId).toBe("usr_owner");
  });

  // 成员增删对任何 Human 成员开放（能力表 member 档，d42），Owner 变更仍是 owner 档。
  it("非 owner 的 Human 成员能改成员、不能换 Owner", () => {
    const facts = factsFor(group, human("usr_other"));
    expect(facts.canChangeMembers).toBe(true);
    expect(facts.canChangeOwner).toBe(false);
    expect(facts.canChangeWakePolicy).toBe(false);
    expect(facts.canRenameTitle).toBe(true);
  });

  // 反证（R3-UI02）：Owner 交给 Agent 之后，d6 的 Project 创建者兜底必须仍能换回 Owner，
  // 否则「Human 指定 Agent 为 owner」的群组在页面上永久冻结。
  it("Agent 当 owner 时，Project 创建者的人类仍可更改 Owner", () => {
    const agentOwner: ChatGovernanceScope = {
      kind: "group",
      ownerKind: "agent",
      ownerId: "agp_1",
      projectCreatedBy: "usr_owner",
    };
    const creator = factsFor(agentOwner, human("usr_owner"));
    expect(creator.canChangeOwner).toBe(true);
    expect(creator.canChangeWakePolicy).toBe(true);
    expect(creator.canChangeMembers).toBe(true);
    expect(creator.projectCreatedBy).toBe("usr_owner");

    const other = factsFor(agentOwner, human("usr_other"));
    expect(other.canChangeOwner).toBe(false);
    expect(other.canChangeWakePolicy).toBe(false);
    // 成员治理不受 owner 档影响（d42 的 member 档），所以没有只读原因，只是不能换 Owner。
    expect(other.readOnlyReason).toBeUndefined();
  });

  it("Agent 在所有治理动作上都拿到 false，并被写明不参与治理", () => {
    const facts = factsFor(group, agent("agp_1"));
    expect(facts.canChangeMembers).toBe(false);
    expect(facts.canChangeOwner).toBe(false);
    expect(facts.canChangeWakePolicy).toBe(false);
    expect(facts.canRenameTitle).toBe(false);
    expect(facts.readOnlyReason).toContain("Agent");
  });

  it("DM 与公共频道没有成员治理入口，但 DM 可以改自己的标题", () => {
    const dm = factsFor({ ...group, kind: "dm" }, human("usr_member"));
    expect(dm.canChangeMembers).toBe(false);
    expect(dm.canChangeOwner).toBe(false);
    expect(dm.canChangeWakePolicy).toBe(false);
    // 标题是会话自己的名字，DM 不依赖群组结构（d46）；改动只走头部入口，不进右栏治理段。
    expect(dm.canRenameTitle).toBe(true);

    const channel = factsFor({ ...group, kind: "public_channel" }, human("usr_owner"));
    expect(Object.values(channel).filter((value) => value === true)).toEqual([]);
  });

  it("判定值与能力表的档位同源：member 档对 Human 开，owner 档看归属", () => {
    expect(CHAT_CAPABILITIES.member_add.human).toBe("member");
    expect(CHAT_CAPABILITIES.owner_change.human).toBe("owner");
    expect(CHAT_CAPABILITIES.title_change.human).toBe("member");
    expect(CHAT_CAPABILITIES.member_add.agent).toBe("never");
  });
});

describe("治理段文案读 facts，不再自己判身份", () => {
  it("Agent owner 的兜底治理者看到的是「可以变更 Owner」", () => {
    const facts = factsFor(
      { kind: "group", ownerKind: "agent", ownerId: "agp_1", projectCreatedBy: "usr_owner" },
      human("usr_owner"),
    );
    const note = governanceNote("group", facts);
    expect(note).toContain("Owner 变更需要当前 Human owner");
    expect(note).not.toContain("只有 owner");
  });

  it("非兜底者看到的是「当前身份不能变更 Owner」", () => {
    const facts = factsFor(
      { kind: "group", ownerKind: "agent", ownerId: "agp_1", projectCreatedBy: "usr_owner" },
      human("usr_other"),
    );
    const note = governanceNote("group", facts);
    expect(note).toContain("当前身份不能变更 Owner");
    expect(note).toContain("Agent 不参与治理");
  });

  it("Agent 行动者看到领域给的只读原因", () => {
    const facts = factsFor(group, agent("agp_1"));
    const note = governanceNote("group", facts);
    expect(note).toContain("Agent 不参与对话治理");
  });

  it("公共频道与 DM 的文案各按 kind 收口", () => {
    expect(
      governanceNote(
        "public_channel",
        factsFor({ ...group, kind: "public_channel" }, human("usr_owner")),
      ),
    ).toBe("公共频道 Owner 固定为 Project 创建者，成员跟随 Project 自动同步。");
    expect(governanceNote("dm", factsFor({ ...group, kind: "dm" }, human("usr_owner")))).toBe("");
  });
});
