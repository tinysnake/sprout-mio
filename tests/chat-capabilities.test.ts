import { describe, expect, it } from "vite-plus/test";

// ChatError 定义在 domain/chat.ts，那个模块装载时就会建立数据库连接。
// 本文件只断言纯判定、不执行任何查询：先把连接指到内存库，再动态载入被测模块。
process.env.DATABASE_URL ??= ":memory:";
const { ChatError } = await import("../src/domain/chat");
const { CHAT_ACTIONS, CHAT_CAPABILITIES, assertChatCapability, chatGovernanceFacts } =
  await import("../src/domain/chat-capabilities");
import type { ChatGovernanceScope } from "../src/domain/chat-capabilities";
import type { ChatAction } from "../src/domain/chat-capabilities";
import type { ChatActor } from "../src/domain/chat-actor";

const ctx = { userId: "usr_1", requestId: "req_test" };
const human = (userId: string): ChatActor => ({ kind: "human", userId, ctx });
const agent = (agentProfileId: string): ChatActor => ({
  kind: "agent",
  agentProfileId,
  instanceId: "ins_1",
  runId: "run_1",
  ctx,
});

type Access = "never" | "member" | "owner";

/** 冻结能力表逐字抄一份：表漂移必须先在这里红。 */
const EXPECTED: Record<ChatAction, { human: Access; agent: Access }> = {
  member_add: { human: "member", agent: "never" },
  member_remove: { human: "member", agent: "never" },
  lead_change: { human: "owner", agent: "never" },
  title_change: { human: "member", agent: "never" },
  message_send: { human: "member", agent: "member" },
};

const OWNER_ACTIONS = CHAT_ACTIONS.filter((action) => EXPECTED[action].human === "owner");
const AGENT_DENIED_ACTIONS = CHAT_ACTIONS.filter((action) => EXPECTED[action].agent === "never");

const facts = (ownerKind: "human" | "agent", ownerId: string, projectCreatedBy: string) =>
  ({
    kind: "crew" as const,
    ownerKind,
    ownerId,
    projectCreatedBy,
  }) satisfies ChatGovernanceScope;

function expectForbidden(action: ChatAction, actor: ChatActor, chat?: ChatGovernanceScope) {
  expect(() => assertChatCapability(action, actor, chat)).toThrow(ChatError);
  let code: string | undefined;
  try {
    assertChatCapability(action, actor, chat);
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code).toBe("forbidden");
}

describe("chat 能力表", () => {
  it("Record 键与 CHAT_ACTIONS 完全一致，每个动作两个身份都有登记级别", () => {
    expect(Object.keys(CHAT_CAPABILITIES).sort()).toEqual([...CHAT_ACTIONS].sort());
    for (const action of CHAT_ACTIONS) {
      expect(CHAT_CAPABILITIES[action]).toEqual(EXPECTED[action]);
      for (const level of Object.values(CHAT_CAPABILITIES[action]))
        expect(["never", "member", "owner"]).toContain(level);
    }
  });

  it("Agent 在全部治理动作上被拒，即使它就是该对话登记的 Agent 所有者", () => {
    expect(AGENT_DENIED_ACTIONS).toEqual(
      CHAT_ACTIONS.filter((action) => action !== "message_send"),
    );
    for (const action of AGENT_DENIED_ACTIONS) {
      expectForbidden(action, agent("agp_1"), facts("human", "usr_1", "usr_1"));
      expectForbidden(action, agent("agp_1"), facts("agent", "agp_1", "usr_1"));
      expectForbidden(action, agent("agp_1"));
    }
  });

  it("Agent 可以发言", () => {
    expect(() => assertChatCapability("message_send", agent("agp_1"))).not.toThrow();
    expect(() =>
      assertChatCapability("message_send", agent("agp_1"), facts("human", "usr_1", "usr_1")),
    ).not.toThrow();
  });

  it("Human 成员能发言，非所有者不能换 lead", () => {
    expect(() => assertChatCapability("message_send", human("usr_2"))).not.toThrow();
    expect(() => assertChatCapability("member_add", human("usr_2"))).not.toThrow();
    for (const action of OWNER_ACTIONS)
      expectForbidden(action, human("usr_2"), facts("human", "usr_1", "usr_1"));
  });

  it("Human 所有者能执行全部 owner 档动作", () => {
    for (const action of OWNER_ACTIONS)
      expect(() =>
        assertChatCapability(action, human("usr_1"), facts("human", "usr_1", "usr_1")),
      ).not.toThrow();
  });

  it("Agent 所有者只让 Project 创建者的人类做治理兜底", () => {
    for (const action of OWNER_ACTIONS) {
      expect(() =>
        assertChatCapability(action, human("usr_1"), facts("agent", "agp_1", "usr_1")),
      ).not.toThrow();
      expectForbidden(action, human("usr_2"), facts("agent", "agp_1", "usr_1"));
    }
  });

  it("人类所有者与 Project 创建者不是同一人时，只有所有者本人通过", () => {
    for (const action of OWNER_ACTIONS) {
      expectForbidden(action, human("usr_1"), facts("human", "usr_2", "usr_1"));
      expect(() =>
        assertChatCapability(action, human("usr_2"), facts("human", "usr_2", "usr_1")),
      ).not.toThrow();
    }
  });

  it("缺少归属事实时 owner 档一律拒绝，Agent 更是连事实都不需要", () => {
    for (const action of OWNER_ACTIONS) {
      expectForbidden(action, human("usr_1"));
      expectForbidden(action, agent("agp_1"));
    }
  });

  it("member 档不要求归属事实", () => {
    for (const action of CHAT_ACTIONS) {
      if (EXPECTED[action].human === "member")
        expect(() => assertChatCapability(action, human("usr_1"))).not.toThrow();
    }
  });

  it("owner 档的放行与 chatGovernanceFacts 的布尔值一一对应", () => {
    const scope = facts("agent", "agp_1", "usr_1");
    const ownerByFallback = human("usr_1");
    expect(chatGovernanceFacts(scope, ownerByFallback).canChangeLead).toBe(true);
    expect(() => assertChatCapability("lead_change", ownerByFallback, scope)).not.toThrow();
    const outsider = human("usr_2");
    expect(chatGovernanceFacts(scope, outsider).canChangeLead).toBe(false);
    expectForbidden("lead_change", outsider, scope);
    expect(() => assertChatCapability("title_change", outsider, scope)).not.toThrow();
  });

  it("DM 没有成员与 lead 治理，但仍可改名与发言", () => {
    const dmScope: ChatGovernanceScope = {
      kind: "dm",
      ownerKind: "human",
      ownerId: "usr_1",
      projectCreatedBy: "usr_1",
    };
    const view = chatGovernanceFacts(dmScope, human("usr_1"));
    expect(view.canChangeMembers).toBe(false);
    expect(view.canChangeLead).toBe(false);
    expect(view.canRenameTitle).toBe(true);
    expect(() => assertChatCapability("title_change", human("usr_1"), dmScope)).not.toThrow();
  });
});
