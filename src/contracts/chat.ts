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

/**
 * 会话的治理事实（裁定 d6 / d45）：Owner 与「当前行动者能不能做什么」由领域层一次算好，
 * 页面只读这份结果。页面自己拼 facts 连续两轮出错（Agent owner 的兜底入口丢失、标题门槛漂移），
 * 所以身份比较只允许出现在 `domain/chat-capabilities.ts` 一处。
 *
 * `projectCreatedBy` 只在 `ownerKind === "agent"` 时是兜底治理者；`readOnlyReason` 是领域层给出的
 * 只读说明，页面直接展示，不再自己判断「为什么不能」。
 *
 * 这里只放「谁能做什么」：`owner`、`wakePolicy`、`governanceRevision` 已经在同一会话的 `chat` 上，
 * 不复写一份，避免两处同步。
 */
export const chatOwnerFactsSchema = z.object({
  ownerKind: memberKind,
  ownerId: z.string().min(1),
  actorKind: memberKind,
  actorId: z.string().min(1),
  projectCreatedBy: z.string().min(1).optional(),
  canChangeMembers: z.boolean(),
  canChangeOwner: z.boolean(),
  canChangeWakePolicy: z.boolean(),
  /** 右栏的重命名入口：只有普通 Group 有；DM 的入口在消息头部（P4b 形状），频道没有入口。 */
  canRenameTitle: z.boolean(),
  readOnlyReason: z.string().optional(),
});
export type ChatOwnerFacts = z.infer<typeof chatOwnerFactsSchema>;

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

/** 频道没有 title 字段（裁定 d8），会话列表与详情用这条固定文案代替。 */
export const PUBLIC_CHANNEL_DISPLAY_TITLE = "公共频道（Project 范围）";

/** 会话没有任何可回落的参与分身名时的兜底：不把裸 chat id 当人类可读名字。 */
export const UNNAMED_CHAT_DISPLAY_TITLE = "未命名对话";

/**
 * 会话的展示标题：频道一律用固定文案（d8）；其余人工标题优先，缺省回落到参与分身名。
 * 纯规则只放一处，读模型与页面引用同一份回落链，不各写一套。
 */
export function chatDisplayTitle(
  chat: Pick<Chat, "kind" | "title">,
  agentNames: readonly string[],
): string {
  if (chat.kind === "public_channel") return PUBLIC_CHANNEL_DISPLAY_TITLE;
  const title = chat.title?.trim();
  if (title) return title;
  const names = agentNames.map((name) => name.trim()).filter((name) => name.length > 0);
  return names.length > 0 ? names.join("、") : UNNAMED_CHAT_DISPLAY_TITLE;
}

/**
 * 会话列表项（也是对话详情里的 chat 部分）。三种 kind 共用一份形状：
 * - `dm` / `group`：`title` 可选，缺省时页面回落到参与分身名；
 * - `public_channel`：没有 `title`，页面显示 `PUBLIC_CHANNEL_DISPLAY_TITLE`；
 *   `createdBy` 就是 `project.created_by`（自动创建，没有命名者），
 *   `owner` 恒为 `{ kind: 'human', id: project.created_by }`；
 *   `wakePolicy` 是 §4.1 的冻结值 `owner_led`，但频道 owner 一定是人类，
 *   所以频道里的有效唤醒只有点名规则：一条消息只唤醒被点名的 Agent，绝不广播给全体成员。
 */
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

/**
 * 人类在 Group / Public Channel 发消息时的唤醒派发契约（裁定 §3.3 / §4.5）。
 *
 * `routeWakeCandidates` 的点名规则按展示名匹配，而 `chat_effective_member` 只给成员 id，
 * 所以派发方必须把「候选 Agent 的 `agent_profile_id` → 展示名」字典与消息内容一起交出去；
 * 字典缺项时点名退化为 `@<agent_profile_id>`。名单顺序即派发顺序，函数自己不再排序。
 */
export const chatWakeDispatchSchema = z.object({
  chatId,
  body: z.string().trim().min(1, "消息不能为空").max(8000, "消息最多 8000 字"),
  agentProfiles: z.array(
    z.object({
      agentProfileId: agentProfileIdSchema,
      profileName: z.string().trim().min(1).optional(),
    }),
  ),
});
export type ChatWakeDispatch = z.infer<typeof chatWakeDispatchSchema>;

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

/** 会话里一个分身的活跃 run：同一分身至多一条活跃 run（`agent_run_one_active_instance` 局部唯一索引）。 */
export const chatActiveRunSchema = z.object({
  runId: z.string().regex(appIdPattern(ID_PREFIXES.run)),
  status: z.enum(["queued", "running"]),
  queuedAt: z.iso.datetime(),
  /** 该 run 上未投递的输入数：与 Info Hub run 视角同一算法。 */
  pendingInputs: z.number().int().min(0),
});
export type ChatActiveRun = z.infer<typeof chatActiveRunSchema>;

/** 会话里的一个分身。DM 恰有一个；群与频道在扇出后可以同时有多个 Agent 的分身。 */
export const chatSessionInstanceSchema = z.object({
  instanceId: z.string().regex(appIdPattern(ID_PREFIXES.instance)),
  agentProfileId: agentProfileIdSchema,
  profileName: z.string(),
  /** 没有排队中或运行中的 run 时整个字段缺省：这不是「缺数据」，是这个分身此刻没在跑。 */
  activeRun: chatActiveRunSchema.optional(),
});
export type ChatSessionInstance = z.infer<typeof chatSessionInstanceSchema>;

/**
 * 会话读模型（多 Agent）：同一份读法按 kind 分形。
 * - `dm` 的形状与改造前的 `ChatDetail` 逐字段一致（P2 冻结），只多出判别字段 `kind`；
 * - `group` / `public_channel` 各带自己的成员与分身集合，不共用 DM 的 `{ chat, instance }`；
 *   频道没有 `title` 列（裁定 d8），读模型直接给出固定文案，页面不再各自回落。
 */
export const dmChatSessionSchema = z.object({
  kind: z.literal("dm"),
  chat: chatSchema,
  instance: agentInstanceSchema,
  governance: chatOwnerFactsSchema,
});
export const groupChatSessionSchema = z.object({
  kind: z.literal("group"),
  chat: chatSchema,
  members: z.array(chatMemberSchema),
  instances: z.array(chatSessionInstanceSchema),
  governance: chatOwnerFactsSchema,
});
export const publicChannelChatSessionSchema = z.object({
  kind: z.literal("public_channel"),
  chat: chatSchema,
  displayTitle: z.literal(PUBLIC_CHANNEL_DISPLAY_TITLE),
  members: z.array(chatMemberSchema),
  instances: z.array(chatSessionInstanceSchema),
  governance: chatOwnerFactsSchema,
});
export const chatSessionSchema = z.discriminatedUnion("kind", [
  dmChatSessionSchema,
  groupChatSessionSchema,
  publicChannelChatSessionSchema,
]);
export type ChatSession = z.infer<typeof chatSessionSchema>;

/** DM 会话详情：DM 恰有一个分身，群组与公共频道的会话详情见 `ChatSession`（不共用本形状）。 */
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
