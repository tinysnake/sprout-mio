import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { projectIdInput } from "./project";

/** 未读读的是「对话列表」这一层：按 Project 一次问，逐 chat 给未读数与最后一条他人消息。 */
export const listChatUnreadInput = z.object({ projectId: projectIdInput.shape.projectId });

/** 已读游标只前进：客户端把当前看到的最新消息 id 报上来，服务端只在新 rowid 更大时写。 */
export const markChatReadInput = z.object({
  chatId: z.string().regex(appIdPattern(ID_PREFIXES.chat)),
  messageId: z.string().regex(appIdPattern(ID_PREFIXES.message)),
});

/**
 * 通知只带展示所需的片段：发送者显示名、正文预览与时间。
 * 不带正文全文，避免把消息内容复制进列表轮询的响应里。
 */
export const chatUnreadLastMessageSchema = z.object({
  id: z.string(),
  senderLabel: z.string(),
  preview: z.string(),
  createdAt: z.string(),
});

export const chatUnreadItemSchema = z.object({
  chatId: z.string(),
  unreadCount: z.number().int().min(1),
  lastMessage: chatUnreadLastMessageSchema.nullable(),
});

export const markChatReadResultSchema = z.object({
  chatId: z.string(),
  unreadCount: z.number().int().min(0),
});

export type ListChatUnreadInput = z.infer<typeof listChatUnreadInput>;
export type MarkChatReadInput = z.infer<typeof markChatReadInput>;
export type ChatUnreadItem = z.infer<typeof chatUnreadItemSchema>;
export type ChatUnreadLastMessage = z.infer<typeof chatUnreadLastMessageSchema>;
export type MarkChatReadResult = z.infer<typeof markChatReadResultSchema>;

/** toast 与浏览器通知共用的正文预览长度。 */
export const CHAT_MESSAGE_PREVIEW_LENGTH = 80;

/**
 * 通知正文：折叠空白（消息可以带换行与缩进）并截断，超长补省略号。
 * 纯函数，前端 tracker 与服务端投影都用同一份规则，不在两处各写一遍。
 */
export function chatMessagePreview(
  body: string,
  limit: number = CHAT_MESSAGE_PREVIEW_LENGTH,
): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}
