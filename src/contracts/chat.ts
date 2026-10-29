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

/**
 * 群组成员条目。Agent 一律用既有 `agp_` id 模式；Human 的 id 来自认证供应方，没有前缀，
 * 只收非空标识并由领域层核对 user 行存在性，不用正则发明一个认证层没有的格式。
 */
export const chatMemberInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: agentProfileIdSchema }),
  z.object({ kind: z.literal("human"), id: z.string().trim().min(1, "成员标识不能为空") }),
]);
export type ChatMemberInput = z.infer<typeof chatMemberInput>;

/** 治理命令里的所有者：Agent 带 `agp_` 模式，Human 是认证供应方的 user.id。 */
export const chatOwnerInput = chatOwnerSchema.superRefine((owner, ctx) => {
  if (owner.kind === "agent" && !agentProfileIdSchema.safeParse(owner.id).success)
    ctx.addIssue({ code: "custom", path: ["id"], message: "分身标识格式无效" });
});
export type ChatOwnerInput = z.infer<typeof chatOwnerInput>;

/**
 * 新建 Group。成员不重复、至少一名人类成员、Agent 所有者必须是成员之一，
 * 这三条是纯形状约束；「成员与 Agent 所有者属本 Project」要查库，归领域层。
 * 没有人类成员的群与没有成员的群一样无法治理，所以在入口就拦掉。
 */
export const createGroupChatInput = z
  .object({
    projectId,
    title: chatTitle.optional(),
    members: z.array(chatMemberInput).min(1, "群组至少要有一个成员"),
    initialOwner: chatOwnerInput,
    wakePolicy: chatWakePolicySchema.default("owner_led"),
  })
  .superRefine((input, ctx) => {
    const keys = input.members.map((member) => `${member.kind}:${member.id}`);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", path: ["members"], message: "成员不能重复" });
    if (!input.members.some((member) => member.kind === "human"))
      ctx.addIssue({ code: "custom", path: ["members"], message: "群组至少要有一名人类成员" });
    if (
      input.initialOwner.kind === "agent" &&
      !input.members.some(
        (member) => member.kind === "agent" && member.id === input.initialOwner.id,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["initialOwner"],
        message: "Agent 所有者必须是群组成员",
      });
  });
export type CreateGroupChatInput = z.infer<typeof createGroupChatInput>;

/** `governance_revision` 是治理写入的乐观并发令牌，调用方必须带上自己看到的那一版。 */
const expectedRevision = z.number().int().nonnegative();

export const addGroupMemberInput = z.object({
  chatId,
  member: chatMemberInput,
  expectedRevision,
});
export type AddGroupMemberInput = z.infer<typeof addGroupMemberInput>;

export const removeGroupMemberInput = z.object({
  chatId,
  member: chatMemberInput,
  expectedRevision,
});
export type RemoveGroupMemberInput = z.infer<typeof removeGroupMemberInput>;

export const setChatOwnerInput = z.object({
  chatId,
  owner: chatOwnerInput,
  expectedRevision,
});
export type SetChatOwnerInput = z.infer<typeof setChatOwnerInput>;

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
