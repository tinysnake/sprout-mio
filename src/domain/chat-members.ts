import { and, asc, eq, sql } from "drizzle-orm";
import type { ChatMember } from "../contracts/chat";
import { db } from "../db";
import { chatEffectiveMember } from "../db/schema";

/**
 * 对话当前有效成员的唯一读入口：直接读派生视图 `chat_effective_member`，
 * 不在应用层拼一份等价判定。DM 与 Crew 的成员来自各自成员行；Agent 还必须仍是
 * Project 成员，Project 级移除后立即从这里消失，但它的历史消息与 run 仍保留。
 *
 * 视图没有 rowid，同一秒加入的成员需要稳定次序：先按加入时间，再让人类排在前面，
 * 最后按成员 id 收口。
 */
export function readChatEffectiveMembers(chatId: string, projectId: string): ChatMember[] {
  return db
    .select()
    .from(chatEffectiveMember)
    .where(
      and(eq(chatEffectiveMember.chatId, chatId), eq(chatEffectiveMember.projectId, projectId)),
    )
    .orderBy(
      asc(chatEffectiveMember.addedAt),
      asc(sql`${chatEffectiveMember.memberKind} <> 'human'`),
      asc(chatEffectiveMember.memberId),
    )
    .all()
    .map((row: typeof chatEffectiveMember.$inferSelect) => ({
      chatId: row.chatId,
      memberKind: row.memberKind,
      memberId: row.memberId,
      addedAt: row.addedAt.toISOString(),
    }));
}
