import type { ChatKind, ChatWakePolicy } from "../contracts/chat";

/** 唤醒候选：一名待派发的分身。 */
export type WakeCandidate = { readonly agentProfileId: string };

export type WakeInput = {
  readonly body: string;
  readonly chat: {
    readonly id: string;
    readonly kind: ChatKind;
    readonly wakePolicy: ChatWakePolicy;
    readonly ownerKind: "human" | "agent";
    readonly ownerId: string;
  };
  readonly effectiveMembers: readonly {
    readonly memberKind: "human" | "agent";
    readonly memberId: string;
    /**
     * 分身在当前 Project 内的展示名。裁定 §3.3 只给了 id，而点名规则按名字匹配，
     * 缺省 name 时只能按 `@<memberId>` 命中；调用方从 `agent_profile` 读出名后传入。
     */
    readonly profileName?: string;
  }[];
  readonly senderAgentProfileId?: string;
};

/** 名字或 id 前后的 ASCII 标识字符会让提及变成另一个更长词的一部分，那样不算点名。 */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

/** 全名是否作为独立词出现；`@` 前缀同样算命中，因为 `@` 不是标识字符。 */
function mentionsName(body: string, name: string): boolean {
  if (name.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = body.indexOf(name, from);
    if (at < 0) return false;
    if (!isWordChar(body[at - 1]) && !isWordChar(body[at + name.length])) return true;
    from = at + 1;
  }
}

/**
 * 一条消息要唤醒谁。纯函数：只吃调用点已经读出的事实，不查库、不排序副作用。
 *
 * 1. 点名：消息体里以全名或 id 提及的当前 Agent 成员，按成员表顺序返回；
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
  const named = agentMembers
    .filter((member) =>
      member.profileName
        ? mentionsName(input.body, member.profileName) || mentionsName(input.body, member.memberId)
        : mentionsName(input.body, member.memberId),
    )
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
