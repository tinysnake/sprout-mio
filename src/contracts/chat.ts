import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const memberKind = z.enum(["human", "agent"]);

export const createDirectChatInput = z.object({
  projectId,
  agentProfileId: agentProfileIdSchema,
});
export type CreateDirectChatInput = z.infer<typeof createDirectChatInput>;
export const chatIdInput = z.object({ chatId });

/** 标题最多 80 字，与 Project / AgentProfile 的名称上限同档，trim 后不允许为空。 */
export const CHAT_TITLE_MAX_LENGTH = 80;
const chatTitle = z
  .string()
  .trim()
  .min(1, "标题不能为空")
  .max(CHAT_TITLE_MAX_LENGTH, `标题最多 ${CHAT_TITLE_MAX_LENGTH} 字`);

/** 重命名标题：只有 Chat 所属 Project 的创建者可以调用。 */
export const updateChatTitleInput = z.object({ chatId, title: chatTitle });
export type UpdateChatTitleInput = z.infer<typeof updateChatTitleInput>;

/** 恢复默认标题：把 title 置空，展示回落到参与分身名。 */
export const clearChatTitleInput = z.object({ chatId });
export type ClearChatTitleInput = z.infer<typeof clearChatTitleInput>;

export const chatSchema = z.object({
  id: chatId,
  projectId,
  kind: z.literal("dm"),
  title: z.string().optional(),
  archivedAt: z.iso.datetime().optional(),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatMemberSchema = z.object({
  chatId,
  memberKind,
  memberId: z.string().min(1),
  addedAt: z.iso.datetime(),
});
export type ChatMember = z.infer<typeof chatMemberSchema>;

export const agentInstanceSchema = z.object({
  id: z.string().regex(appIdPattern(ID_PREFIXES.instance)),
  agentProfileId: agentProfileIdSchema,
  chatId,
  projectId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type DirectChat = { chat: Chat; instance: AgentInstance };

export const sendMessageInput = z.object({
  senderKind: memberKind,
  senderId: z.string().min(1),
  body: z.string().trim().min(1, "消息不能为空").max(8000, "消息最多 8000 字"),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export const messageSchema = sendMessageInput.extend({
  id: z.string().regex(appIdPattern(ID_PREFIXES.message)),
  chatId,
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;
export type ChatResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
