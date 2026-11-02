import type { ChatKind, ChatWakePolicy, MentionSpan } from "../contracts/chat";

/** 唤醒候选：一名待派发的分身。 */
export type WakeCandidate = { readonly agentProfileId: string };

/** 成员身份：点名记录、提示与候选都只认这一对键。 */
export type WakeMember = {
  readonly memberKind: "human" | "agent";
  readonly memberId: string;
};

export type WakeInput = {
  readonly chat: {
    readonly id: string;
    readonly kind: ChatKind;
    readonly wakePolicy: ChatWakePolicy;
    readonly ownerKind: "human" | "agent";
    readonly ownerId: string;
  };
  readonly effectiveMembers: readonly WakeMember[];
  /**
   * 这条消息写时解析落库的点名落点（`message_mention` 那一份）。路由只读它，
   * 不再从正文里匹配名字：正文里出现名字不是点名，不进候选。
   */
  readonly mentions: readonly MentionSpan[];
  readonly senderAgentProfileId?: string;
};

const memberKey = (member: WakeMember): string => `${member.memberKind}:${member.memberId}`;

/**
 * 一条消息要唤醒谁。纯函数：只吃调用点已经读出的事实，不查库、不排序副作用。
 *
 * 1. 点名：`mentions` 记录里出现的当前 Agent 成员，按成员表顺序返回；
 * 2. 所有者优先：无人被点名且策略为 `owner_led` 或 `contextual`（P5a 回退同义）时，
 *    Agent 所有者进入候选；
 * 3. 其余情况退避为空集。
 *
 * 两条规则都排除发消息的分身自己，并且只接受 `chat_effective_member` 给出的当前成员：
 * 移出项目的分身留在历史行里，但不该再被唤醒。
 */
export function routeWakeCandidates(input: WakeInput): readonly WakeCandidate[] {
  const agentMembers = input.effectiveMembers.filter(
    (member) => member.memberKind === "agent" && member.memberId !== input.senderAgentProfileId,
  );
  const mentioned = new Set(input.mentions.map(memberKey));
  const named = agentMembers
    .filter((member) => mentioned.has(memberKey(member)))
    .map((member) => ({ agentProfileId: member.memberId }));
  if (named.length > 0) return named;

  const ownerLed = input.chat.wakePolicy === "owner_led" || input.chat.wakePolicy === "contextual";
  if (
    ownerLed &&
    input.chat.ownerKind === "agent" &&
    input.chat.ownerId !== input.senderAgentProfileId &&
    agentMembers.some((member) => member.memberId === input.chat.ownerId)
  )
    return [{ agentProfileId: input.chat.ownerId }];
  return [];
}

export type NameHintInput = {
  readonly body: string;
  readonly mentions: readonly MentionSpan[];
  /** 成员名来自 `agent_profile.name` / `user.name`，缺名时无法在正文里认出来。 */
  readonly members: readonly (WakeMember & { readonly profileName?: string })[];
};

/**
 * 正文里出现了名字、但不在任何 mention span 里的成员。这是**弱证据**，不参与路由：
 * `routeWakeCandidates` 不读它的返回，它只随唤醒评估的输入交给判定器，含义是
 * 「对方在正文里提到了它的名字」，不是点名，判定器可以据此说不。
 *
 * 只按字面出现判断，不划词边界：提示本来就是弱证据，多报一次只是让判定器多看一眼，
 * 划边界反而给「它算不算出现」多加一条要维护的规则。是否点名由 mention span 说了算。
 */
export function nameHints(input: NameHintInput): readonly WakeMember[] {
  const spans = input.mentions;
  return input.members
    .filter((member) => {
      const name = member.profileName ?? "";
      if (name.length === 0) return false;
      for (let from = 0; ;) {
        const at = input.body.indexOf(name, from);
        if (at < 0) return false;
        const end = at + name.length;
        if (!spans.some((span) => at < span.end && span.start < end)) return true;
        from = at + 1;
      }
    })
    .map((member) => ({ memberKind: member.memberKind, memberId: member.memberId }));
}
