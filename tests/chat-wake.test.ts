import { describe, expect, it } from "vite-plus/test";
import type { MentionSpan } from "../src/contracts/chat";
import {
  nameHints,
  routeWakeCandidates,
  type WakeInput,
  type WakeMember,
} from "../src/domain/chat-wake";
import { prepareWakeEvaluation, type WakeSnapshotFacts } from "../src/domain/wake-evaluation";
import { createLlmJudge, wakeSessionId, type LlmRequest } from "../src/domain/wake-providers/llm";

/** 纯函数用例只构造事实：本文件不 import 任何查库的领域模块。 */
const REVIEWER: WakeMember = { memberKind: "agent", memberId: "agp_reviewer" };
const RUNNER: WakeMember = { memberKind: "agent", memberId: "agp_runner" };
const HUMAN: WakeMember = { memberKind: "human", memberId: "usr_1" };
const REVIEWER_NAME = "小审";
const RUNNER_NAME = "小跑";

/** 一条点名落点：`text` 在 `body` 里的位置，与写时解析器落库的形状一致。 */
function span(member: WakeMember, body: string, text: string): MentionSpan {
  const start = body.indexOf(text);
  if (start < 0) throw new Error(`正文里没有 ${text}`);
  return {
    memberKind: member.memberKind,
    memberId: member.memberId,
    start,
    end: start + text.length,
  };
}

function input(
  overrides: {
    mentions?: readonly MentionSpan[];
    chat?: Partial<WakeInput["chat"]>;
    members?: readonly WakeMember[];
    senderAgentProfileId?: string;
  } = {},
): WakeInput {
  return {
    chat: {
      id: "cnv_1",
      kind: "group",
      wakePolicy: "mention_only",
      ownerKind: "human",
      ownerId: "usr_1",
      ...overrides.chat,
    },
    effectiveMembers: overrides.members ?? [HUMAN, REVIEWER, RUNNER],
    mentions: overrides.mentions ?? [],
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
  it("点名记录命中的当前 Agent 成员就是全部候选", () => {
    const body = "@小审 请先看这条回归";
    expect(routeWakeCandidates(input({ mentions: [span(REVIEWER, body, "@小审")] }))).toEqual([
      { agentProfileId: "agp_reviewer" },
    ]);
  });

  it("一条消息点名多名分身时按成员表顺序全部入候选", () => {
    const body = "@小跑 和 @小审 一起看";
    expect(
      routeWakeCandidates(
        input({
          mentions: [span(RUNNER, body, "@小跑"), span(REVIEWER, body, "@小审")],
        }),
      ),
    ).toEqual([{ agentProfileId: "agp_reviewer" }, { agentProfileId: "agp_runner" }]);
  });

  it("同一成员被点名两次只产一个候选，且不改动入参", () => {
    const body = "@小审 先说，小审 再说";
    const source = input({ mentions: [span(REVIEWER, body, "@小审")] });
    const before = JSON.stringify(source);
    expect(routeWakeCandidates(source)).toEqual([{ agentProfileId: "agp_reviewer" }]);
    expect(JSON.stringify(source)).toEqual(before);
  });

  it("点名优先于 owner 兜底", () => {
    const body = "@小审 由你开始，先别惊动别人";
    expect(
      routeWakeCandidates(input({ mentions: [span(REVIEWER, body, "@小审")], chat: ownerAgent })),
    ).toEqual([{ agentProfileId: "agp_reviewer" }]);
  });

  it("正文里出现名字不是点名：没有 mention 记录就不进候选", () => {
    // 这条正文写了全名，但写时解析器没有落任何 span（例如名字是后来才改的）。
    expect(routeWakeCandidates(input({ mentions: [] }))).toEqual([]);
  });

  it("点名记录指向非当前成员时被忽略", () => {
    const body = "@小审 你也看看";
    expect(
      routeWakeCandidates(
        input({
          mentions: [span(REVIEWER, body, "@小审")],
          members: [HUMAN, RUNNER],
          chat: { wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" },
        }),
      ),
    ).toEqual([]);
  });

  it("无人被点名时 agent owner 进入候选，contextual 在 P5a 同义回退", () => {
    for (const wakePolicy of ["owner_led", "contextual"] as const) {
      expect(
        routeWakeCandidates(
          input({
            chat: { wakePolicy, ownerKind: "agent", ownerId: "agp_runner" },
          }),
        ),
      ).toEqual([{ agentProfileId: "agp_runner" }]);
    }
  });

  it("退避空集：mention_only 无点名、Human 所有者都不唤醒", () => {
    expect(routeWakeCandidates(input())).toEqual([]);
    expect(
      routeWakeCandidates(
        input({ chat: { wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" } }),
      ),
    ).toEqual([]);
  });

  it("发送者不唤醒自己：点名与 owner 兜底都排除发消息的分身", () => {
    const body = "@小审 @小跑";
    expect(
      routeWakeCandidates(
        input({
          mentions: [span(REVIEWER, body, "@小审"), span(RUNNER, body, "@小跑")],
          senderAgentProfileId: "agp_runner",
          chat: ownerAgent,
        }),
      ),
    ).toEqual([{ agentProfileId: "agp_reviewer" }]);
    expect(
      routeWakeCandidates(input({ senderAgentProfileId: "agp_runner", chat: ownerAgent })),
    ).toEqual([]);
  });

  it("owner 已被移出项目时不再唤醒它", () => {
    expect(routeWakeCandidates(input({ members: [HUMAN, REVIEWER], chat: ownerAgent }))).toEqual(
      [],
    );
  });

  it("DM 结果为空集：实际派发仍走既有 appendHumanRunInput", () => {
    expect(
      routeWakeCandidates(
        input({
          chat: { kind: "dm", wakePolicy: "owner_led", ownerKind: "human", ownerId: "usr_1" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("nameHints", () => {
  const members = [
    { ...HUMAN, profileName: "阿青" },
    { ...REVIEWER, profileName: REVIEWER_NAME },
    { ...RUNNER, profileName: RUNNER_NAME },
  ];

  it("裸名字只产生提示，不进路由", () => {
    const body = "小审 你看下这条";
    expect(nameHints({ body, mentions: [], members })).toEqual([REVIEWER]);
    expect(routeWakeCandidates(input({ mentions: [] }))).toEqual([]);
  });

  it("落在 mention span 里的名字不算提示", () => {
    const body = "@小审 请先看这条";
    expect(nameHints({ body, mentions: [span(REVIEWER, body, "@小审")], members })).toEqual([]);
  });

  it("同一个名字既有 span 又在别处裸写时仍算提示", () => {
    const body = "@小审 先说，小审 再说";
    expect(nameHints({ body, mentions: [span(REVIEWER, body, "@小审")], members })).toEqual([
      REVIEWER,
    ]);
  });

  it("名字是更长中文名的前缀：@小审美 由写时解析器落成「小审」的点名", () => {
    const body = "@小审美 看一下";
    const mentions = [span(REVIEWER, body, "@小审")];
    // 前缀命中是解析器既有行为：它落了 span，于是这条是显式点名，路由必达。
    expect(routeWakeCandidates(input({ mentions }))).toEqual([{ agentProfileId: "agp_reviewer" }]);
    // 提示只认 span 之外的出现位置，这里没有第二个「小审」，所以不产生弱证据。
    expect(nameHints({ body, mentions, members })).toEqual([]);
  });

  it("没有展示名的成员、正文里没有的名字都不产生提示", () => {
    expect(
      nameHints({
        body: "小跑 看一下",
        mentions: [],
        members: [{ ...REVIEWER }, { ...RUNNER, profileName: RUNNER_NAME }],
      }),
    ).toEqual([RUNNER]);
    expect(nameHints({ body: "大家看一下", mentions: [], members })).toEqual([]);
  });
});

/** 快照里的成员标识是 `{kind, id}`；唤醒路由的成员键是 `{memberKind, memberId}`。 */
const recipientOf = (member: WakeMember) => ({ kind: member.memberKind, id: member.memberId });

/** 唤醒评估的装配事实：两名 Agent 成员、群聊、一条触发消息。 */
function facts(
  overrides: {
    body?: string;
    mentions?: readonly MentionSpan[];
    wakePolicy?: "mention_only" | "owner_led" | "contextual";
    owner?: WakeMember;
  } = {},
): WakeSnapshotFacts {
  const body = overrides.body ?? "这条谁来跟进";
  const members = [
    [REVIEWER, REVIEWER_NAME],
    [RUNNER, RUNNER_NAME],
  ] as const;
  return {
    source: "message",
    projectId: "prj_00000001",
    chatId: "cnv_00000001",
    triggerId: "msg_00000002",
    round: 1,
    controlEpoch: 1,
    policy: { provider: "llm", configRevision: 1, thresholdVersion: "unit-v1" },
    archived: false,
    triggerMessage: {
      id: "msg_00000002",
      kind: "human",
      sender: recipientOf(HUMAN),
      body,
      createdAt: "2026-01-01T00:00:02.000Z",
      truncated: false,
    },
    mentions: overrides.mentions ?? [],
    latestReadableMessageId: "msg_00000002",
    recentMessages: [
      {
        id: "msg_00000001",
        kind: "human",
        sender: recipientOf(HUMAN),
        body: "开工了",
        createdAt: "2026-01-01T00:00:01.000Z",
        truncated: false,
      },
    ],
    chat: {
      kind: "group",
      goal: "一起推进",
      collaboration: "按职责协作",
      owner: overrides.owner ? recipientOf(overrides.owner) : recipientOf(HUMAN),
      wakePolicy: overrides.wakePolicy ?? "contextual",
      governanceRevision: 1,
    },
    members: members.map(([member, profileName], index) => ({
      candidate: {
        recipient: recipientOf(member),
        instanceId: `ins_0000000${index}`,
        personaSummary: profileName,
        responsibility: "推进当前对话",
        activeRun: null,
        latestRun: null,
        externalWork: [],
      },
      profileName,
      projectMember: true,
      effectiveMember: true,
    })),
    tasks: [],
  };
}

describe("prepareWakeEvaluation 的点名与提示", () => {
  it("显式点名走规则分支：只有被点名的人，判定器没有否决权", () => {
    const body = "@小审 把结论贴到验收记录";
    const prepared = prepareWakeEvaluation(
      facts({ body, mentions: [span(REVIEWER, body, "@小审")] }),
      new Date("2026-01-01T00:00:03.000Z"),
    );
    expect(prepared.kind).toBe("rule");
    if (prepared.kind !== "rule") return;
    expect(prepared.result.selectedRecipients).toEqual([recipientOf(REVIEWER)]);
    expect(prepared.result.reasonCode).toBe("explicit_rule");
    expect(prepared.result.recipients).toEqual([
      {
        recipient: recipientOf(REVIEWER),
        decision: "yes",
        reason: "显式点名既已记录，判定器无权否决",
        probability: null,
      },
    ]);
    expect(prepared.input.mentions).toEqual([{ recipient: recipientOf(REVIEWER), explicit: true }]);
  });

  it("裸名字不路由：快照里只带一条 explicit=false 的弱证据", () => {
    const prepared = prepareWakeEvaluation(
      facts({ body: "小审 你看下这条" }),
      new Date("2026-01-01T00:00:03.000Z"),
    );
    expect(prepared.kind).toBe("model");
    if (prepared.kind !== "model") return;
    expect(prepared.input.candidates.map((c) => c.recipient)).toEqual([
      recipientOf(REVIEWER),
      recipientOf(RUNNER),
    ]);
    expect(prepared.input.mentions).toEqual([
      { recipient: recipientOf(REVIEWER), explicit: false },
    ]);
  });

  it("owner_led 且无人点名时回落 owner，行为与路由规则一致", () => {
    const prepared = prepareWakeEvaluation(
      facts({ wakePolicy: "owner_led", owner: RUNNER }),
      new Date("2026-01-01T00:00:03.000Z"),
    );
    expect(prepared.kind).toBe("rule");
    if (prepared.kind !== "rule") return;
    expect(prepared.result.selectedRecipients).toEqual([recipientOf(RUNNER)]);
    expect(prepared.result.recipients[0]!.reason).toBe("对话唤醒策略回落到当前 owner");
    expect(prepared.input.mentions).toEqual([]);
  });

  it("没有任何点名线索时不产出点名条目", () => {
    const prepared = prepareWakeEvaluation(facts(), new Date("2026-01-01T00:00:03.000Z"));
    expect(prepared.kind).toBe("model");
    if (prepared.kind !== "model") return;
    expect(prepared.input.mentions).toEqual([]);
  });
});

describe("LLM 的网关身份", () => {
  it("同一群聊的每次唤醒沿用同一个 session id", async () => {
    const prepared = prepareWakeEvaluation(facts(), new Date("2026-01-01T00:00:03.000Z"));
    if (prepared.kind !== "model") throw new Error("夹具应走模型判定");
    const input = {
      ...prepared.input,
      policy: { ...prepared.input.policy, model: "test/model" },
    };
    let seen: LlmRequest | undefined;
    const judge = createLlmJudge({
      agentDir: "/tmp/sprout-agent",
      clock: () => 0,
      complete: async (request) => {
        seen = request;
        return {
          text: JSON.stringify({
            decisions: input.candidates.map((candidate) => ({
              recipient: candidate.recipient,
              decision: "no",
              certainty: "high",
              reason: "测试",
            })),
          }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    });
    await judge(input);
    expect(seen?.sessionId).toBe(wakeSessionId("cnv_00000001"));
    expect(seen?.sessionId).toBe("sprout-wake-cnv_00000001");
    expect(seen?.userAgent).toMatch(/^sprout-mio\//);
  });
});
