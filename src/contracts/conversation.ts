import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

const conversationId = z.string().regex(appIdPattern(ID_PREFIXES.conversation));
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const memberKind = z.enum(["human", "agent"]);

export const createDirectConversationInput = z.object({
  projectId,
  agentProfileId: agentProfileIdSchema,
});
export type CreateDirectConversationInput = z.infer<typeof createDirectConversationInput>;
export const conversationIdInput = z.object({ conversationId });

export const conversationSchema = z.object({
  id: conversationId,
  projectId,
  kind: z.literal("dm"),
  title: z.string().optional(),
  archivedAt: z.iso.datetime().optional(),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationMemberSchema = z.object({
  conversationId,
  memberKind,
  memberId: z.string().min(1),
  addedAt: z.iso.datetime(),
});
export type ConversationMember = z.infer<typeof conversationMemberSchema>;

export const agentInstanceSchema = z.object({
  id: z.string().regex(appIdPattern(ID_PREFIXES.instance)),
  agentProfileId: agentProfileIdSchema,
  conversationId,
  projectId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type DirectConversation = { conversation: Conversation; instance: AgentInstance };

export const sendMessageInput = z.object({
  senderKind: memberKind,
  senderId: z.string().min(1),
  body: z.string().trim().min(1, "消息不能为空").max(8000, "消息最多 8000 字"),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;
export const messageSchema = sendMessageInput.extend({
  id: z.string().regex(appIdPattern(ID_PREFIXES.message)),
  conversationId,
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;
export type ConversationResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
