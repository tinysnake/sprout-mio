import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const memberKind = z.enum(["human", "agent"]);

/** 对话种类：DM 一对一、Group 普通群组、Public Channel 项目内唯一公共频道。 */
export const chatKindSchema = z.enum(["dm", "group", "public_channel"]);
export type ChatKind = z.infer<typeof chatKindSchema>;

/** 唤醒策略：contextual 在 I-P5a 按裁定回退为 owner_led 语义。 */
export const chatWakePolicySchema = z.enum(["mention_only", "owner_led", "contextual"]);
export type ChatWakePolicy = z.infer<typeof chatWakePolicySchema>;

/** 对话所有者：Human 引用 user.id，Agent 引用 agentProfileId；DM 只能是创建者本人。 */
export const chatOwnerSchema = z.object({
  kind: memberKind,
  id: z.string().min(1, "所有者标识不能为空"),
});
export type ChatOwner = z.infer<typeof chatOwnerSchema>;

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

/** 新建 Group：初始成员至少一名分身，所有者与唤醒策略由调用方显式给出。 */
export const createGroupChatInput = z.object({
  projectId,
  title: chatTitle.optional(),
  agentProfileIds: z.array(z.string()).min(1, "群组至少要有一个分身成员"),
  initialOwner: chatOwnerSchema,
  wakePolicy: chatWakePolicySchema.default("owner_led"),
});
export type CreateGroupChatInput = z.infer<typeof createGroupChatInput>;

export const chatSchema = z.object({
  id: chatId,
  projectId,
  kind: chatKindSchema,
  title: z.string().optional(),
  archivedAt: z.iso.datetime().optional(),
  owner: chatOwnerSchema,
  wakePolicy: chatWakePolicySchema,
  governanceRevision: z.number().int().nonnegative(),
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

/** 对话详情：DM 恰有一个分身，群组与公共分身的集合由后续单元按成员展开。 */
export type ChatDetail = { chat: Chat; instance: AgentInstance };
/**
 * @deprecated 名称把「一对一」写进了通用类型，I-P5a 起统一用 ChatDetail。
 * 别名只保留一个阶段，新代码不要再引用它。
 */
export type DirectChat = ChatDetail;

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
