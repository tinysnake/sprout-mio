import { and, asc, eq, inArray } from "drizzle-orm";
import type { ChatMember, MentionSpan } from "../contracts/chat";
import { db } from "../db";
import { agentProfile, messageMention, user } from "../db/schema";
import { ChatError } from "./chat";
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
 * 一条消息最终记下谁被点名。规则分两段，顺序不能换：
 *
 * 1. `picks` 是客户端选择器的结果，先写死：它带来「用户点的是谁」，而正文里可能写着另一个
 *    写法（显示名与成员名不同、重名消歧）。成员必须仍是这条对话的当前有效成员，否则抛错——
 *    这里不接受客户端送来的成员表，也不静默丢弃一个点不出来的结果。
 * 2. 没被 `picks` 覆盖的正文段各自跑一次 `resolveMentions` 补全手打的 `@名字`。按段跑而不是
 *    先跑再过滤：跨过 picks 的 span 会被截断，两段结果不会重叠，`message_mention` 的
 *    `(chat_id, message_id, start)` 唯一键因此不会被自己撞上。
 */
export function resolveMessageMentions(input: {
  readonly body: string;
  readonly members: readonly ChatMember[];
  readonly candidates: readonly MentionCandidate[];
  readonly picks?: readonly MentionSpan[] | undefined;
}): readonly MentionSpan[] {
  const picks = pickSpans(input.body, input.members, input.picks ?? []);
  const spans: MentionSpan[] = [];
  let cursor = 0;
  for (const pick of picks) {
    spans.push(
      ...resolveMentions(input.body.slice(cursor, pick.start), input.candidates).map((span) => ({
        ...span,
        start: span.start + cursor,
        end: span.end + cursor,
      })),
    );
    spans.push(pick);
    cursor = pick.end;
  }
  spans.push(
    ...resolveMentions(input.body.slice(cursor), input.candidates).map((span) => ({
      ...span,
      start: span.start + cursor,
      end: span.end + cursor,
    })),
  );
  return spans;
}

/**
 * `picks` 的自证：位置要落在正文内、起点是 `@`、彼此不重叠，成员要在这条对话的有效成员里。
 * 位置与正文对不上是客户端算错了偏移（例如按未 trim 的输入算），落库会得到指向别处的 mention，
 * 所以宁可让这次发送失败。
 */
function pickSpans(
  body: string,
  members: readonly ChatMember[],
  picks: readonly MentionSpan[],
): readonly MentionSpan[] {
  if (picks.length === 0) return [];
  const known = new Set(members.map(memberKey));
  const ordered = [...picks].sort((left, right) => left.start - right.start);
  let previousEnd = 0;
  for (const pick of ordered) {
    if (!known.has(memberKey(pick))) throw new ChatError("not_found", "点名的成员不在这条对话里");
    if (pick.start < previousEnd) throw new ChatError("conflict", "点名位置不能重叠");
    if (pick.end > body.length || pick.start >= pick.end)
      throw new ChatError("conflict", "点名位置超出消息正文");
    if (body[pick.start] !== "@") throw new ChatError("conflict", "点名位置不在 @ 上");
    previousEnd = pick.end;
  }
  return ordered;
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
