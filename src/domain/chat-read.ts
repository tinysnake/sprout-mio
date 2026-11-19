import { eq } from "drizzle-orm";
import { chatMessagePreview } from "../contracts/chat-read";
import type { ChatUnreadItem, MarkChatReadResult } from "../contracts/chat-read";
import { db, sqlite } from "../db";
import { agentProfile, chat, message, user } from "../db/schema";
import type { ProjectContext } from "./access";
import { assertProjectAccess } from "./access";
import { ChatError, getChat } from "./chat";

type SenderKind = (typeof message.$inferSelect)["senderKind"];

type CursorRow = { cursor: number };

type ForeignMessageRow = {
  id: string;
  senderKind: SenderKind;
  senderId: string;
  body: string;
  createdAt: number;
};

/**
 * 未读数只看游标之后的「非本人」消息：本人刚发的那条不该算自己没读。
 * `rowid` 比较天然吸收并发追加，不需要维护计数。
 */
function countUnread(chatId: string, userId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS count
         FROM message m
        WHERE m.chat_id = ?
          AND m.sender_id <> ?
          AND m.rowid > COALESCE((
                SELECT cursor.rowid
                  FROM chat_read_marker r
                  JOIN message cursor ON cursor.id = r.message_id
                 WHERE r.chat_id = ? AND r.user_id = ?
              ), 0)`,
    )
    .get(chatId, userId, chatId, userId) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** 未读项的通知预览取「最新一条他人消息」，本人发的最新消息不作提醒文案。 */
function latestForeignMessage(chatId: string, userId: string): ForeignMessageRow | undefined {
  return sqlite
    .prepare(
      `SELECT m.id AS id, m.sender_kind AS senderKind, m.sender_id AS senderId,
              m.body AS body, m.created_at AS createdAt
         FROM message m
        WHERE m.chat_id = ? AND m.sender_id <> ?
        ORDER BY m.rowid DESC
        LIMIT 1`,
    )
    .get(chatId, userId) as ForeignMessageRow | undefined;
}

/**
 * 发送者显示名。四种派生发送者没有可读名字，给固定文案；
 * agent 的 senderId 是 profile id，租约提醒等系统发送者可能查不到，退回「助理」。
 */
export function senderLabelFor(senderKind: SenderKind, senderId: string): string {
  switch (senderKind) {
    case "human": {
      const name = db
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, senderId))
        .get()?.name;
      return name ?? "用户";
    }
    case "agent": {
      const name = db
        .select({ name: agentProfile.name })
        .from(agentProfile)
        .where(eq(agentProfile.id, senderId))
        .get()?.name;
      return name ?? "助理";
    }
    case "automation":
      return "自动化";
    case "assistant_event":
    case "assistant_work":
      return "助手";
    case "delegation_event":
      return "委派";
    default:
      return "成员";
  }
}

/**
 * Project 下所有「人类可进入」对话的未读（口径与 `chatListChats` 一致：委派子对话不列）。
 * 只返回有未读的项，每项带上最新一条他人消息供 toast / 浏览器通知取文案。
 */
export function listChatUnread(projectId: string, ctx: ProjectContext): ChatUnreadItem[] {
  assertProjectAccess(ctx, projectId);
  const rows = db
    .select({ id: chat.id, kind: chat.kind })
    .from(chat)
    .where(eq(chat.projectId, projectId))
    .all();
  const items: ChatUnreadItem[] = [];
  for (const row of rows) {
    if (row.kind === "delegation") continue;
    const unreadCount = countUnread(row.id, ctx.userId);
    if (unreadCount <= 0) continue;
    const latest = latestForeignMessage(row.id, ctx.userId);
    items.push({
      chatId: row.id,
      unreadCount,
      lastMessage: latest
        ? {
            id: latest.id,
            senderLabel: senderLabelFor(latest.senderKind, latest.senderId),
            preview: chatMessagePreview(latest.body),
            createdAt: new Date(latest.createdAt * 1000).toISOString(),
          }
        : null,
    });
  }
  return items;
}

/**
 * 推进已读游标到 `messageId`。校验消息属于该对话；upsert 只在新区 rowid 更大时生效，
 * 因此重复调用与「报一条旧消息」都幂等且不会让游标后退。返回写后的未读数。
 */
export function markChatRead(
  chatId: string,
  messageId: string,
  ctx: ProjectContext,
): MarkChatReadResult {
  getChat(chatId, ctx);
  const target = sqlite
    .prepare("SELECT rowid AS cursor FROM message WHERE id = ? AND chat_id = ?")
    .get(messageId, chatId) as CursorRow | undefined;
  if (!target) throw new ChatError("not_found", "消息不存在");
  sqlite
    .prepare(
      `INSERT INTO chat_read_marker (chat_id, user_id, message_id, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(chat_id, user_id) DO UPDATE SET
         message_id = excluded.message_id,
         updated_at = excluded.updated_at
       WHERE (SELECT rowid FROM message WHERE id = excluded.message_id) > COALESCE(
         (SELECT rowid FROM message WHERE id = chat_read_marker.message_id), 0)`,
    )
    .run(chatId, ctx.userId, messageId);
  return { chatId, unreadCount: countUnread(chatId, ctx.userId) };
}
