import { and, asc, eq, inArray } from "drizzle-orm";
import type { ChatMember, MentionSpan } from "../contracts/chat";
import { db } from "../db";
import { agentProfile, messageMention, user } from "../db/schema";
import { resolveMentions } from "./mention";
import type { MentionCandidate } from "./mention";

const memberKey = (member: { memberKind: "human" | "agent"; memberId: string }): string =>
  `${member.memberKind}:${member.memberId}`;

/**
 * 成员视图只给 id，点名却按名字匹配，名字必须在写时补齐：Agent 取 `agent_profile.name`，
 * Human 取 `user.name`。两张表各一次批量读，不按成员逐个查。
 *
 * 候选顺序沿用成员视图的次序（加入时间 → 人类优先 → 成员 id），`resolveMentions` 在等长名字
 * 撞车时按这个顺序取靠前的那个，所以同一个对话的解析结果与成员读出的顺序一致。
 */
export function mentionCandidatesFor(members: readonly ChatMember[]): readonly MentionCandidate[] {
  const names = new Map<string, string>();
  const agentIds = members.filter((m) => m.memberKind === "agent").map((m) => m.memberId);
  const humanIds = members.filter((m) => m.memberKind === "human").map((m) => m.memberId);
  if (agentIds.length > 0)
    for (const row of db
      .select({ id: agentProfile.id, name: agentProfile.name })
      .from(agentProfile)
      .where(inArray(agentProfile.id, agentIds))
      .all())
      names.set(memberKey({ memberKind: "agent", memberId: row.id }), row.name);
  if (humanIds.length > 0)
    for (const row of db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, humanIds))
      .all())
      names.set(memberKey({ memberKind: "human", memberId: row.id }), row.name);
  return members.map((member) => ({
    memberKind: member.memberKind,
    memberId: member.memberId,
    name: names.get(memberKey(member)) ?? "",
  }));
}

/**
 * 一条消息最终记下谁被点名：拿这条对话当前有效成员的展示名逐段匹配正文里的 `@名字`。
 *
 * 成员名在同一个 owner 名下唯一，一条对话的成员又都来自同一个 Project，所以同一条正文里
 * 不会有两个成员可被同一段文字命中匹配，不需要客户端额外送一份「用户点的是谁」。
 */
export function resolveMessageMentions(input: {
  readonly body: string;
  readonly candidates: readonly MentionCandidate[];
}): readonly MentionSpan[] {
  return resolveMentions(input.body, input.candidates);
}

export function writeMessageMentions(
  chatId: string,
  messageId: string,
  spans: readonly MentionSpan[],
): void {
  if (spans.length === 0) return;
  db.insert(messageMention)
    .values(
      spans.map((span) => ({
        chatId,
        messageId,
        memberKind: span.memberKind,
        memberId: span.memberId,
        start: span.start,
        end: span.end,
      })),
    )
    .run();
}

/**
 * 一批消息的 mention 一次读出并按 messageId 归并，读侧不做 N+1。
 * 排序按 `start`，页面上的点名顺序与正文顺序一致。
 */
export function readMentionsFor(
  chatId: string,
  messageIds: readonly string[],
): ReadonlyMap<string, MentionSpan[]> {
  const byMessage = new Map<string, MentionSpan[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = db
    .select()
    .from(messageMention)
    .where(
      and(eq(messageMention.chatId, chatId), inArray(messageMention.messageId, [...messageIds])),
    )
    .orderBy(asc(messageMention.messageId), asc(messageMention.start))
    .all();
  for (const row of rows) {
    const span: MentionSpan = {
      memberKind: row.memberKind,
      memberId: row.memberId,
      start: row.start,
      end: row.end,
    };
    const existing = byMessage.get(row.messageId);
    if (existing) existing.push(span);
    else byMessage.set(row.messageId, [span]);
  }
  return byMessage;
}
