import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAT_ACTIONS, CHAT_CAPABILITIES } from "../src/contracts/chat-capabilities";
import { assertChatCapability, chatGovernanceFacts } from "../src/domain/chat-capabilities";
import { ChatError } from "../src/domain/chat";
import type { AppErrorCode } from "../src/contracts/result";
import { ResultError } from "../src/components/project/result-error";

/**
 * 裁定 d45/d46：页面看 `can*`，领域断言看同一份事实。第四轮验收用临时改档位证明过两处会分叉
 * （title_change 被读成 canChangeMembers、DM 入口只按 kind 渲染），这里把「同一个档位下两边一致」
 * 写成断言，改档位的人必须让两处同时变。
 */
const ctx = {
  userId: "usr_requester",
  requestId: "req_33333333-3333-4333-8333-333333333333",
};

const owner = { kind: "human" as const, userId: "usr_owner", ctx };
const member = { kind: "human" as const, userId: "usr_member", ctx };
const agent = {
  kind: "agent" as const,
  agentProfileId: "agp_agent",
  instanceId: "ins_33333333-3333-4333-8333-333333333333",
  runId: "run_33333333-3333-4333-8333-333333333333",
  ctx,
};

const scope = {
  kind: "group" as const,
  ownerKind: "human" as const,
  ownerId: "usr_owner",
  projectCreatedBy: "usr_creator",
};

function allowed(action: (typeof CHAT_ACTIONS)[number], actor: typeof owner): boolean {
  try {
    assertChatCapability(action, actor, scope);
    return true;
  } catch (error) {
    if (error instanceof ChatError) return false;
    throw error;
  }
}

describe("治理事实与领域断言读同一份判定", () => {
  it("owner 档下所有者与普通成员的结果两处一致", () => {
    const facts = chatGovernanceFacts(scope, member);
    expect(facts.canChangeOwner).toBe(false);
    expect(allowed("owner_change", member)).toBe(false);
    expect(chatGovernanceFacts(scope, owner).canChangeOwner).toBe(true);
    expect(allowed("owner_change", owner)).toBe(true);
  });

  it("临时把 title_change 改成 owner 档后，非所有者两处都拒绝", () => {
    const previous = CHAT_CAPABILITIES.title_change.human;
    try {
      CHAT_CAPABILITIES.title_change.human = "owner";
      expect(chatGovernanceFacts(scope, member).canRenameTitle).toBe(false);
      expect(allowed("title_change", member)).toBe(false);
      expect(chatGovernanceFacts(scope, owner).canRenameTitle).toBe(true);
      expect(allowed("title_change", owner)).toBe(true);
    } finally {
      CHAT_CAPABILITIES.title_change.human = previous;
    }
  });

  it("临时把 title_change 改成 never 后，页面事实与断言都拒绝", () => {
    const previous = CHAT_CAPABILITIES.title_change.human;
    try {
      CHAT_CAPABILITIES.title_change.human = "never";
      expect(chatGovernanceFacts(scope, owner).canRenameTitle).toBe(false);
      expect(allowed("title_change", owner)).toBe(false);
    } finally {
      CHAT_CAPABILITIES.title_change.human = previous;
    }
  });

  it("Agent 在任何档位都不参与治理", () => {
    const facts = chatGovernanceFacts(scope, agent);
    expect(facts.canChangeMembers).toBe(false);
    expect(facts.canChangeOwner).toBe(false);
    expect(facts.canChangeWakePolicy).toBe(false);
    expect(facts.canRenameTitle).toBe(false);
  });
});

describe("DM 标题是会话自己的名字", () => {
  const dmScope = {
    kind: "dm" as const,
    ownerKind: "human" as const,
    ownerId: "usr_owner",
    projectCreatedBy: "usr_creator",
  };

  it("member 档下 DM 可以改名，断言也放行", () => {
    expect(chatGovernanceFacts(dmScope, member).canRenameTitle).toBe(true);
    try {
      assertChatCapability("title_change", member, dmScope);
    } catch {
      throw new Error("DM 在 member 档下应当允许改标题");
    }
  });

  it("公共频道标题由 Project 派生，任何档位都不给改名", () => {
    const channelScope = { ...dmScope, kind: "public_channel" as const };
    expect(chatGovernanceFacts(channelScope, owner).canRenameTitle).toBe(false);
  });
});

describe("失败呈现只在 not_found 里露出 requestId", () => {
  function markup(code: Exclude<AppErrorCode, "project_member_removal_blocked">): string {
    return renderToStaticMarkup(
      createElement(ResultError, {
        error: {
          code,
          message: "当前对话不存在",
          requestId: "req_22222222-2222-4222-8222-222222222222",
        },
      }),
    );
  }

  it("members 的 conflict 只说错误码", () => {
    const html = markup("conflict");
    expect(html).toContain("conflict");
    expect(html).not.toMatch(/req_[0-9a-f-]{36}/);
  });

  it("深链的 validation_failed 也不带内部标识", () => {
    expect(markup("validation_failed")).not.toContain("req_22222222");
  });

  it("not_found 保留 requestId，用户还能拿去查诊断", () => {
    expect(markup("not_found")).toContain("req_22222222-2222-4222-8222-222222222222");
  });
});
