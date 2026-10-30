import { describe, expect, it } from "vite-plus/test";
import { routeWakeCandidates, type WakeInput } from "../src/domain/chat-wake";

/** 纯函数用例只构造事实：本文件不 import 任何查库的领域模块。 */
type WakeMember = WakeInput["effectiveMembers"][number];

const REVIEWER: WakeMember = {
  memberKind: "agent",
  memberId: "agp_reviewer",
  profileName: "小审",
};
const RUNNER: WakeMember = { memberKind: "agent", memberId: "agp_runner", profileName: "小跑" };
const HUMAN: WakeMember = { memberKind: "human", memberId: "usr_1" };

function input(
  overrides: {
    body?: string;
    chat?: Partial<WakeInput["chat"]>;
    members?: readonly WakeMember[];
    senderAgentProfileId?: string;
  } = {},
): WakeInput {
  return {
    body: overrides.body ?? "",
    chat: {
      id: "cnv_1",
      kind: "group",
      wakePolicy: "mention_only",
      ownerKind: "human",
      ownerId: "usr_1",
      ...overrides.chat,
    },
    effectiveMembers: overrides.members ?? [HUMAN, REVIEWER, RUNNER],
    ...(overrides.senderAgentProfileId
      ? { senderAgentProfileId: overrides.senderAgentProfileId }
      : {}),
  };
}

const ownerAgent = {
  wakePolicy: "owner_led" as const,
  ownerKind: "agent" as const,
  ownerId: "agp_runner",
};

describe("routeWakeCandidates", () => {
  it("点名只唤醒被提及的当前 Agent 成员", () => {
    expect(routeWakeCandidates(input({ body: "请小审先看这条回归", chat: ownerAgent }))).toEqual([
      { agentProfileId: "agp_reviewer" },
    ]);
  });

  it("一条消息点名多名分身时按成员表顺序全部入候选", () => {
    expect(routeWakeCandidates(input({ body: "小审 和 小跑 一起看" }))).toEqual([
      { agentProfileId: "agp_reviewer" },
      { agentProfileId: "agp_runner" },
    ]);
  });

  it("点名优先于 owner 兜底", () => {
    expect(
      routeWakeCandidates(input({ body: "@小审 由你开始，先别惊动别人", chat: ownerAgent })),
    ).toEqual([{ agentProfileId: "agp_reviewer" }]);
  });

  it("没有分身名时仍按 id 命中点名", () => {
    expect(
      routeWakeCandidates(
        input({
          body: "@agp_runner 处理",
          members: [HUMAN, { memberKind: "agent", memberId: "agp_runner" }],
        }),
      ),
    ).toEqual([{ agentProfileId: "agp_runner" }]);
  });

  it("无人被点名时 agent owner 进入候选，contextual 在 P5a 同义回退", () => {
    for (const wakePolicy of ["owner_led", "contextual"] as const) {
      expect(
        routeWakeCandidates(
          input({
            body: "这条谁来跟进",
            chat: { wakePolicy, ownerKind: "agent", ownerId: "agp_runner" },
          }),
        ),
      ).toEqual([{ agentProfileId: "agp_runner" }]);
    }
  });

  it("退避空集：mention_only 无点名、Human 所有者都不唤醒", () => {
    expect(routeWakeCandidates(input({ body: "随便聊聊" }))).toEqual([]);
    expect(
      routeWakeCandidates(
        input({
          body: "随便聊聊",
          chat: { wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" },
        }),
      ),
    ).toEqual([]);
  });

  it("点名非成员被忽略", () => {
    expect(
      routeWakeCandidates(
        input({
          body: "@小审 你也看看",
          members: [HUMAN, RUNNER],
          chat: { wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" },
        }),
      ),
    ).toEqual([]);
  });

  it("发送者不唤醒自己：点名与 owner 兜底都排除发消息的分身", () => {
    expect(
      routeWakeCandidates(
        input({ body: "@小审 @小跑", senderAgentProfileId: "agp_runner", chat: ownerAgent }),
      ),
    ).toEqual([{ agentProfileId: "agp_reviewer" }]);
    expect(
      routeWakeCandidates(
        input({ body: "我自己继续跟进", senderAgentProfileId: "agp_runner", chat: ownerAgent }),
      ),
    ).toEqual([]);
  });

  it("owner 已被移出项目时不再唤醒它", () => {
    expect(
      routeWakeCandidates(
        input({ body: "继续推进", members: [HUMAN, REVIEWER], chat: ownerAgent }),
      ),
    ).toEqual([]);
  });

  it("DM 结果为空集：实际派发仍走既有 appendHumanRunInput", () => {
    expect(
      routeWakeCandidates(
        input({
          body: "在吗",
          chat: { kind: "dm", wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" },
        }),
      ),
    ).toEqual([]);
  });

  it("名字落在更长的标识词里不算点名", () => {
    expect(
      routeWakeCandidates(
        input({
          body: "agp_runner_backup 的配置读不到",
          members: [HUMAN, { memberKind: "agent", memberId: "agp_runner" }],
        }),
      ),
    ).toEqual([]);
  });

  it("重复提及只产一个候选，且不改动入参", () => {
    const source = input({ body: "@小审 小审 小审" });
    const membersBefore = JSON.stringify(source);
    expect(routeWakeCandidates(source)).toEqual([{ agentProfileId: "agp_reviewer" }]);
    expect(JSON.stringify(source)).toEqual(membersBefore);
  });
});
