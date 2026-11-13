import { z } from "zod";
import { attachmentIdSchema, attachmentSchema } from "./attachment";
import { automationSourceSchema } from "./automation";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";
import { messageSkillSpanSchema } from "./skill";

const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const memberKind = z.enum(["human", "agent"]);

/** 对话种类：DM 一对一、Group 普通群组、Public Channel 项目内唯一公共频道。 */
export const chatKindSchema = z.enum(["dm", "group", "public_channel"]);
export type ChatKind = z.infer<typeof chatKindSchema>;

/** 唤醒策略：`contextual` 由判定器从有效 Agent 候选里选收件人；`owner_led` / `mention_only` 不走判定器。 */
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
 *   `wakePolicy` 是 `contextual`（Public Channel 默认走判定器），但频道 owner 一定是人类，
 *   所以点名仍即时硬路由：一条消息只唤醒被点名的 Agent，绝不广播给全体成员。
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
 * 一处点名的落点：`start`/`end` 是 `message.body` 的字符下标，`end` 开区间，span 含 `@`。
 * 形状只在这里定义一次：写时解析器、消息输入与消息输出都引用同一份 schema。
 */
export const mentionSpanSchema = z.object({
  memberKind,
  memberId: z.string().min(1, "点名成员标识不能为空"),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export type MentionSpan = z.infer<typeof mentionSpanSchema>;

/**
 * 正文里对附件的引用片段，形状与 mention/skill 一致：半开区间，单位是 `message.body` 的字符下标。
 * 存 id 不存文件名：同名附件靠 id 分清，渲染与投递都按这段位置定位。
 */
export const messageAttachmentSpanSchema = z.object({
  attachmentId: attachmentIdSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export type MessageAttachmentSpan = z.infer<typeof messageAttachmentSpanSchema>;

/**
 * 一条消息的唤醒派发契约（裁定 §3.3 / §4.5）：唤醒路由只读这条消息写时解析落库的点名
 * 记录，正文文本不再参与路由。所以派发方交出的就是消息自己的 mention span，不另带名字字典。
 */
export const chatWakeDispatchSchema = z.object({
  chatId,
  mentions: z.array(mentionSpanSchema),
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
/** 消息输出：`mentions` 是写时按本条对话成员解析出来的结果。 */
const messageBaseSchema = z.object({
  skills: z.array(messageSkillSpanSchema),
  senderId: z.string().min(1),
  body: z.string().trim().min(1, "消息不能为空"),
  id: z.string().regex(appIdPattern(ID_PREFIXES.message)),
  chatId,
  createdAt: z.iso.datetime(),
  mentions: z.array(mentionSpanSchema),
  attachments: z.array(attachmentSchema),
  attachmentSpans: z.array(messageAttachmentSpanSchema),
  taskRecord: z
    .strictObject({
      taskId: z.string().regex(appIdPattern(ID_PREFIXES.task)),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      kind: z.enum(["start", "progress", "correction"]),
      referenceMessageId: z.string().regex(appIdPattern(ID_PREFIXES.message)).optional(),
      authorRunId: z.string().regex(appIdPattern(ID_PREFIXES.run)).optional(),
    })
    .optional(),
});
export const messageSchema = z
  .discriminatedUnion("senderKind", [
    messageBaseSchema.extend({
      senderKind: z.literal("assistant_event"),
      nativeSource: z.strictObject({
        kind: z.literal("assistant_event"),
        eventId: z.string(),
        summary: z.string().optional(),
        projectId: z.string(),
        chatId: z.string(),
        runId: z.string().optional(),
      }),
      automationSource: z.never().optional(),
      taskRecord: z.never().optional(),
      mentions: z.tuple([]),
      skills: z.tuple([]),
      attachments: z.tuple([]),
      attachmentSpans: z.tuple([]),
    }),
    messageBaseSchema.extend({
      senderKind: z.literal("assistant_work"),
      nativeSource: z.strictObject({ kind: z.literal("assistant_work"), proposalId: z.string() }),
      automationSource: z.never().optional(),
      taskRecord: z.never().optional(),
      mentions: z.tuple([]),
      skills: z.tuple([]),
      attachments: z.tuple([]),
      attachmentSpans: z.tuple([]),
    }),
    messageBaseSchema.extend({
      senderKind: z.literal("human"),
      automationSource: z.never().optional(),
    }),
    messageBaseSchema.extend({
      senderKind: z.literal("agent"),
      automationSource: z.never().optional(),
    }),
    messageBaseSchema.extend({
      senderKind: z.literal("automation"),
      automationSource: automationSourceSchema,
      taskRecord: z.never().optional(),
      mentions: z.tuple([]),
      skills: z.tuple([]),
      attachments: z.tuple([]),
      attachmentSpans: z.tuple([]),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.senderKind === "automation" && value.senderId !== value.automationSource.triggerId)
      ctx.addIssue({ code: "custom", path: ["senderId"], message: "来源身份必须指向触发回执" });
  });
export type Message = z.infer<typeof messageSchema>;
export type ChatResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };

/**
 * 消息增量读的游标：`<createdAt 秒>:<rowid>`。
 * `createdAt` 只到秒，同一秒插入的多条消息靠 `rowid` 分先后；两者合起来才与领域查询的
 * `asc(createdAt), asc(rowid)` 同序，单用时间戳会漏掉同一秒里后面的消息。
 */
export const messageCursorSchema = z.string().regex(/^\d+:\d+$/);
export type MessageCursor = z.infer<typeof messageCursorSchema>;

function cursorParts(cursor: MessageCursor): [createdAt: number, rowId: number] {
  const [createdAt, rowId] = cursor.split(":");
  return [Number(createdAt), Number(rowId)];
}

/** 按 (createdAt, rowid) 两个数值比，不按字符串比：`"10:2"` 晚于 `"9:11"`。 */
export function compareMessageCursor(left: MessageCursor, right: MessageCursor): number {
  const [leftCreatedAt, leftRowId] = cursorParts(left);
  const [rightCreatedAt, rightRowId] = cursorParts(right);
  return leftCreatedAt - rightCreatedAt || leftRowId - rightRowId;
}

/** 两个游标取较晚的一个。null 表示「还没有位置」，不是最早的位置。 */
export function laterMessageCursor(
  left: MessageCursor | null,
  right: MessageCursor | null,
): MessageCursor | null {
  if (left === null) return right;
  if (right === null) return left;
  return compareMessageCursor(left, right) >= 0 ? left : right;
}

/**
 * 一页消息的条数：首屏、向更早翻页与增量读的默认上限。
 * 客户端不能要求比它更大的页，否则一次读就能把整段历史拉回浏览器。
 */
export const CHAT_MESSAGE_PAGE_SIZE = 50;

/** 单次消息读允许的最大条数，与 `CHAT_MESSAGE_PAGE_SIZE` 分开是为了给翻页留调整空间。 */
export const CHAT_MESSAGE_PAGE_LIMIT_MAX = 100;

/**
 * 一次消息读的结果：按 `(createdAt, rowid)` 升序的一页，加上两个方向的位置。
 * 客户端不自己推断边界：`hasOlder` 由服务端多读一条判定，`olderCursor` 用库里真实的 rowid。
 */
export type MessageWindow = {
  /** 本页消息，按时间升序；最多 `limit` 条（服务端上限 `CHAT_MESSAGE_PAGE_LIMIT_MAX`）。 */
  messages: Message[];
  /** 这批消息之后的位置；空窗口回显请求的 `before`/`after`，都没有且 Chat 为空时为 null。 */
  tailCursor: MessageCursor | null;
  /** 这批消息之前的位置，向更早翻页时传给 `before`；空窗口为 null。 */
  olderCursor: MessageCursor | null;
  /** `olderCursor` 之前是否还有消息；`after` 增量读只看更晚，读一页再看更早没有意义，恒为 false。 */
  hasOlder: boolean;
  /**
   * `tailCursor` 之后是否还有消息。首屏尾巴读恒为 false，由服务端多读一条判定：
   * 只有指定了 `after` 时它才可能是 true，客户端据此决定"回到最新"是否还要再读。
   */
  hasNewer: boolean;
};

/**
 * 消息读：都不带时读最新一页；`before` 向更早翻页，`after` 读该位置之后的增量。
 * 两个方向同时给没有意义，边界直接拒绝，不猜客户端想要哪一个。
 */
export const listMessagesInput = chatIdInput
  .extend({
    before: messageCursorSchema.optional(),
    after: messageCursorSchema.optional(),
    limit: z.number().int().min(1).max(CHAT_MESSAGE_PAGE_LIMIT_MAX).optional(),
  })
  .refine((input) => input.before === undefined || input.after === undefined, {
    message: "before 与 after 不能同时给出",
    path: ["before"],
  });
export type ListMessagesInput = z.infer<typeof listMessagesInput>;
