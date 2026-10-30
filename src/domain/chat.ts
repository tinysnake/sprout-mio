import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  CHAT_TITLE_MAX_LENGTH,
  type AgentInstance,
  type Chat,
  type ChatDetail,
  type ChatMember,
  type ChatMemberInput,
  type ChatOwner,
  type CreateGroupChatInput,
  type Message,
  type SendMessageInput,
} from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentRun,
  agentRunInput,
  chat,
  chatEffectiveMember,
  chatMember,
  message,
  project,
  projectMember,
  user,
} from "../db/schema";
import { assertProjectAccess, ProjectAccessError, readRunScope } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile } from "./agent";
import { appendHumanRunInput, appendOwnerAgentRunInput } from "./agent-run";
import { assertChannelMemberChangeAllowed, readChatEffectiveMembers } from "./channel";
import { assertChatCapability } from "./chat-capabilities";
import type { ChatGovernanceScope } from "./chat-capabilities";
import type { ChatActor } from "./chat-actor";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

export class ChatError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "forbidden" | "channel_membership_managed",
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

function toChat(row: typeof chat.$inferSelect): Chat {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.toISOString() }),
    owner: { kind: row.ownerKind, id: row.ownerId },
    wakePolicy: row.wakePolicy,
    governanceRevision: row.governanceRevision,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInstance(row: typeof agentInstance.$inferSelect): AgentInstance {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toMessage(row: typeof message.$inferSelect): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    senderKind: row.senderKind,
    senderId: row.senderId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    ...(row.taskId !== null && row.taskRecordSeq !== null && row.taskRecordKind !== null
      ? {
          taskRecord: {
            taskId: row.taskId,
            seq: row.taskRecordSeq,
            kind: row.taskRecordKind,
            ...(row.taskReferenceMessageId === null
              ? {}
              : { referenceMessageId: row.taskReferenceMessageId }),
            ...(row.taskAuthorRunId === null ? {} : { authorRunId: row.taskAuthorRunId }),
          },
        }
      : {}),
  };
}

/**
 * 治理判定的事实一次查齐：对话种类与所有者，加上 `project.created_by`。
 * 能力判定只吃这份事实（裁定 d6），调用方不需要、也不允许自己再比一次 owner。
 * 导出给会话读模型：页面要读的 `governance` 与领域拒绝读的是同一份输入。
 */
export function chatGovernanceScope(row: Chat): ChatGovernanceScope {
  const parent = db
    .select({ createdBy: project.createdBy })
    .from(project)
    .where(eq(project.id, row.projectId))
    .get();
  if (!parent) throw new ProjectAccessError();
  return {
    kind: row.kind,
    ownerKind: row.owner.kind,
    ownerId: row.owner.id,
    projectCreatedBy: parent.createdBy,
  };
}

/**
 * 成员与所有者治理只对普通 Group 生效。Public Channel 的成员是 Project 成员的派生事实（裁定 d8），
 * 独立增删一律 `channel_membership_managed`（拒绝入口在 `domain/channel.ts`）；
 * DM 的成员由创建时固定，没有可调整的成员集。
 */
function assertGovernableGroup(row: Chat): void {
  assertChannelMemberChangeAllowed(row);
  if (row.kind !== "group") throw new ChatError("forbidden", "只有群组可以调整成员与所有者");
}

/**
 * Agent 执行身份的对话范围：run 自己的对话与 instance 是唯一判据，调用方传的 `projectId`
 * 与 `chatId` 不能抬高范围。Human 不受影响，历史读取能力原样保留。
 *
 * 两层一起构成「这次运行就在这个对话里」：
 * 1. run 的 Project/chat/instance 与 `ctx.agent` 一致——跨 Project、跨对话、拿别人的 instance 一律拒绝；
 * 2. 该分身仍是 `chat_effective_member`——参与权只认视图（d7），与工具网关的 actor() 同源，
 *    所以「成员行物理保留但已移出」的 instance 不会再被它自己读到。
 * 活跃状态是第三层，但只对发言生效（见 `assertActiveRun`：结束后的运行仍可读自己的历史）。
 */
function assertChatScope(row: Chat, ctx: ProjectContext): void {
  if (!ctx.agent) return;
  const scope = readRunScope(ctx.agent.runId);
  if (!scope) throw new ProjectAccessError();
  if (
    scope.projectId !== row.projectId ||
    scope.chatId !== row.id ||
    scope.instanceId !== ctx.agent.instanceId ||
    scope.agentProfileId !== ctx.agent.agentProfileId
  )
    throw new ProjectAccessError();
  const member = db
    .select({ memberId: chatEffectiveMember.memberId })
    .from(chatEffectiveMember)
    .where(
      and(
        eq(chatEffectiveMember.chatId, row.id),
        eq(chatEffectiveMember.projectId, row.projectId),
        eq(chatEffectiveMember.memberKind, "agent"),
        eq(chatEffectiveMember.memberId, scope.agentProfileId),
      ),
    )
    .get();
  if (!member) throw new ChatError("not_found", "对话成员不存在");
}

/** 发言比读取多一条：已结束的 run 不能再用它的身份写消息（N04）。 */
function assertActiveRun(ctx: ProjectContext): void {
  if (!ctx.agent) return;
  const scope = readRunScope(ctx.agent.runId);
  if (!scope?.active) throw new ChatError("forbidden", "Agent run 不在活跃状态，不能发言");
}

/**
 * 有效参与权（裁定 d7）：只认 `chat_effective_member` 这一份视图，不在应用层另拼一份。
 * 能力表只判「是不是人」（`title_change` 的 member 档），「是不是这条对话的成员」是运行时事实，
 * 由这个判定补上——A03 的缺口就是两边都以为对方会查。
 */
export function isEffectiveMember(
  actor: ChatActor,
  current: { readonly id: string; readonly projectId: string },
): boolean {
  const memberId = actor.kind === "human" ? actor.userId : actor.agentProfileId;
  const row = db
    .select({ memberId: chatEffectiveMember.memberId })
    .from(chatEffectiveMember)
    .where(
      and(
        eq(chatEffectiveMember.chatId, current.id),
        eq(chatEffectiveMember.projectId, current.projectId),
        eq(chatEffectiveMember.memberKind, actor.kind),
        eq(chatEffectiveMember.memberId, memberId),
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * 治理版本推进的两种前置：调用方自己读到的版本（CAS），与项目驱动变化的无版本推进（裁定 d30）。
 */
type GovernanceExpectation = number | "unconditional";

/**
 * 治理写入的乐观并发生效点：只有调用方看到的版本仍是当前版本时才写，
 * 影响行数为 0 就是 `conflict`——别人已经改过，覆盖它就是无声丢失一次治理操作。
 *
 * 项目驱动的成员变化（`revokeProjectAgentEnrollment`）没有调用方的群组版本号，传
 * `"unconditional"` 走同一个推进入口：版本只在这里加，不在第二个地方各算一次。
 */
function applyGovernance(
  row: Chat,
  expected: GovernanceExpectation,
  patch: { ownerKind?: "human" | "agent"; ownerId?: string } = {},
): Chat {
  const updated = db
    .update(chat)
    .set({ ...patch, governanceRevision: row.governanceRevision + 1, updatedAt: new Date() })
    .where(
      and(
        eq(chat.id, row.id),
        eq(chat.projectId, row.projectId),
        ...(expected === "unconditional" ? [] : [eq(chat.governanceRevision, expected)]),
      ),
    )
    .returning()
    .get();
  if (!updated) throw new ChatError("conflict", "群组已被并发修改，请刷新后重试");
  return toChat(updated);
}

/** Agent 成员与 Agent 所有者共用这条前置：必须先属于本项目，否则群组引用一个项目外分身。 */
function requireProjectAgent(projectId: string, agentProfileId: string, ctx: ProjectContext): void {
  getAgentProfile(agentProfileId, ctx);
  const member = db
    .select({ agentProfileId: projectMember.agentProfileId })
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.agentProfileId, agentProfileId)),
    )
    .get();
  if (!member) throw new ChatError("not_found", "Project 成员不存在");
}

/** Human 成员的 id 来自认证供应方，没有前缀；用 user 行存在性收口，不写悬空成员。 */
function requireUser(userId: string): void {
  const row = db.select({ id: user.id }).from(user).where(eq(user.id, userId)).get();
  if (!row) throw new ChatError("not_found", "用户不存在");
}

/** 该 Agent 在本对话里的全部 instance（群组也只有一个，DM 亦然；按集合写便于两种对话共用）。 */
function instanceIdsOf(chatId: string, agentProfileId: string): string[] {
  return db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(and(eq(agentInstance.chatId, chatId), eq(agentInstance.agentProfileId, agentProfileId)))
    .all()
    .map((row: { id: string }) => row.id);
}

/**
 * 该 Agent 在本 Project 的全部 instance。项目级处置要跨对话一次算齐：群组移除只算一个对话的，
 * 项目移除要算该 Agent 在本 Project 所有对话里的。instance 本身按 (对话, Agent) 唯一，
 * 所以拿到 id 集合就等于拿到了「这人参与过哪些对话的运行」。
 */
function projectInstanceIdsOf(projectId: string, agentProfileId: string): string[] {
  return db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(
      and(eq(agentInstance.projectId, projectId), eq(agentInstance.agentProfileId, agentProfileId)),
    )
    .all()
    .map((row: { id: string }) => row.id);
}

/** 活跃 run：`queued` 或 `running`，同一个 instance 由局部唯一索引保证至多一条。 */
function activeRunOf(instanceIds: readonly string[]): string | undefined {
  if (instanceIds.length === 0) return undefined;
  return db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        inArray(agentRun.instanceId, [...instanceIds]),
        inArray(agentRun.status, ["queued", "running"]),
      ),
    )
    .get()?.id;
}

/**
 * 未下发输入的取消：只动 `pending`。`delivered` 已经进入那轮上下文，停它走 P4c 的执行取消路径
 * （裁定 d11）；把两套取消语义混在一起，历史里就说不清是谁停的。
 * 范围用 instance id 集合表达：群组移除给一个对话的，项目移除给整个 Project 的。
 */
function cancelPendingRunInputs(instanceIds: readonly string[]): number {
  if (instanceIds.length === 0) return 0;
  const runs = db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(inArray(agentRun.instanceId, [...instanceIds]))
    .all()
    .map((row: { id: string }) => row.id);
  if (runs.length === 0) return 0;
  const cancelled = db
    .update(agentRunInput)
    .set({
      disposition: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "membership_revoked",
    })
    .where(and(inArray(agentRunInput.runId, runs), eq(agentRunInput.disposition, "pending")))
    .returning({ runId: agentRunInput.runId })
    .all();
  return cancelled.length;
}

export function createDirectChat(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): ChatDetail {
  return sqlite
    .transaction(() => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const member = db
        .select()
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .get();
      if (!member) throw new ChatError("not_found", "Project 成员不存在");
      const existing = db
        .select({ chat, instance: agentInstance })
        .from(chat)
        .innerJoin(
          agentInstance,
          and(eq(agentInstance.chatId, chat.id), eq(agentInstance.projectId, chat.projectId)),
        )
        .where(
          and(
            eq(chat.projectId, projectId),
            eq(chat.kind, "dm"),
            eq(chat.createdBy, ctx.userId),
            eq(agentInstance.agentProfileId, agentProfileId),
          ),
        )
        .orderBy(asc(chat.createdAt), asc(chat.id))
        .get();
      if (existing)
        return {
          chat: toChat(existing.chat),
          instance: toInstance(existing.instance),
        };
      const chatId = newId(ID_PREFIXES.chat);
      const instanceId = newId(ID_PREFIXES.instance);
      return writeIdentity(
        ctx,
        {
          event: "chat.created",
          message: "DM 已创建",
          projectId,
          chatId,
          instanceId,
        },
        () => {
          const created = db
            .insert(chat)
            .values({
              id: chatId,
              projectId,
              kind: "dm",
              createdBy: ctx.userId,
              // DDL 要求 DM 的 owner 就是创建者本身，不留空让调用方选。
              ownerKind: "human",
              ownerId: ctx.userId,
            })
            .returning()
            .get();
          db.insert(chatMember)
            .values([
              { chatId, memberKind: "human", memberId: ctx.userId },
              { chatId, memberKind: "agent", memberId: agentProfileId },
            ])
            .run();
          const instance = db
            .insert(agentInstance)
            .values({ id: instanceId, agentProfileId, chatId, projectId })
            .returning()
            .get();
          return { chat: toChat(created), instance: toInstance(instance) };
        },
        hooks,
      );
    })
    .immediate();
}

export function listChats(projectId: string, ctx: ProjectContext): Chat[] {
  assertProjectAccess(ctx, projectId);
  return db
    .select()
    .from(chat)
    .where(eq(chat.projectId, projectId))
    .orderBy(desc(chat.updatedAt), desc(sql`rowid`))
    .all()
    .map(toChat);
}

export function getChat(chatId: string, ctx: ProjectContext): Chat {
  const row = db.select().from(chat).where(eq(chat.id, chatId)).get();
  if (!row) throw new ProjectAccessError();
  assertProjectAccess(ctx, row.projectId);
  const current = toChat(row);
  assertChatScope(current, ctx);
  return current;
}

/**
 * 重命名标题。归属与权限在服务端领域层核对：不属于当前用户 Project 的 Chat
 * 与不存在的 Chat 都返回 not_found，不暴露存在性。
 * 标题写入是治理动作（`title_change`）：行动者的身份类别由能力表判定（Agent 一律 forbidden），
 * Human 还要是本对话的有效成员（R2-A03）——能力表只回答「是不是人」，参与权读视图。
 */
export function updateChatTitle(
  chatId: string,
  title: string,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  const normalized = title.trim();
  if (normalized.length === 0) throw new ChatError("conflict", "标题不能为空");
  if (normalized.length > CHAT_TITLE_MAX_LENGTH)
    throw new ChatError("conflict", `标题最多 ${CHAT_TITLE_MAX_LENGTH} 字`);
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertChatCapability("title_change", actor, chatGovernanceScope(current));
      if (actor.kind === "human" && !isEffectiveMember(actor, current))
        throw new ChatError("not_found", "对话成员不存在");
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.title_updated",
          message: "对话标题已更新",
          projectId: current.projectId,
          chatId,
        },
        () => {
          const row = db
            .update(chat)
            .set({ title: normalized, updatedAt: new Date() })
            .where(and(eq(chat.id, chatId), eq(chat.projectId, current.projectId)))
            .returning()
            .get();
          if (!row) throw new ChatError("not_found", "对话不存在");
          return toChat(row);
        },
        hooks,
      );
    })
    .immediate();
}

/** 恢复默认标题：title 置回 null，展示回落到参与分身名。权限与改名同一档（`title_change`）。 */
export function clearChatTitle(
  chatId: string,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertChatCapability("title_change", actor, chatGovernanceScope(current));
      if (actor.kind === "human" && !isEffectiveMember(actor, current))
        throw new ChatError("not_found", "对话成员不存在");
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.title_cleared",
          message: "对话标题已恢复默认",
          projectId: current.projectId,
          chatId,
        },
        () => {
          const row = db
            .update(chat)
            .set({ title: null, updatedAt: new Date() })
            .where(and(eq(chat.id, chatId), eq(chat.projectId, current.projectId)))
            .returning()
            .get();
          if (!row) throw new ChatError("not_found", "对话不存在");
          return toChat(row);
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 成员列表读 `chat_effective_member`（裁定 d7），不读 `chat_member`：
 * 频道的成员来自 Project 成员，Project 级移除后该 Agent 立即不在这里出现，
 * 但它的历史消息、instance 与 run 仍然可读。
 */
export function listChatMembers(chatId: string, ctx: ProjectContext): ChatMember[] {
  const current = getChat(chatId, ctx);
  return readChatEffectiveMembers(chatId, current.projectId);
}

export function listInstancesForChat(chatId: string, ctx: ProjectContext): AgentInstance[] {
  const current = getChat(chatId, ctx);
  return db
    .select()
    .from(agentInstance)
    .where(and(eq(agentInstance.chatId, chatId), eq(agentInstance.projectId, current.projectId)))
    .orderBy(asc(agentInstance.createdAt), asc(sql`rowid`))
    .all()
    .map(toInstance);
}

export function getInstance(instanceId: string, ctx: ProjectContext): AgentInstance {
  const row = db.select().from(agentInstance).where(eq(agentInstance.id, instanceId)).get();
  if (!row) throw new ProjectAccessError();
  // Agent 只能取自己 run 的那个 instance；同一对话里别人的 instance 也不在它的范围里。
  if (ctx.agent && ctx.agent.instanceId !== instanceId) throw new ProjectAccessError();
  const current = getChat(row.chatId, ctx);
  if (current.projectId !== row.projectId) throw new ProjectAccessError();
  return toInstance(row);
}

export function listMessages(chatId: string, ctx: ProjectContext): Message[] {
  const current = getChat(chatId, ctx);
  return db
    .select({ entry: message })
    .from(message)
    .innerJoin(chat, eq(chat.id, message.chatId))
    .where(and(eq(message.chatId, chatId), eq(chat.projectId, current.projectId)))
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .all()
    .map(({ entry }: { entry: typeof message.$inferSelect }) => toMessage(entry));
}

export function sendMessage(
  chatId: string,
  input: SendMessageInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): Message {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, ctx);
      // N04：agent sender 必须带这次 run 的身份。`assertActiveRun` 对无 `ctx.agent` 直接返回，
      // 后面的成员与 instance 检查也证明不了「这次写入属于哪次运行」，所以在入口就拒绝。
      if (input.senderKind === "agent" && !ctx.agent)
        throw new ChatError("forbidden", "Agent 发言必须带本次 run 的身份");
      assertActiveRun(ctx);
      // run 里执行的域代码只能以本 run 的分身说话：否则人类消息开出的 run 就能冒充人类发言。
      if (
        ctx.agent &&
        (input.senderKind !== "agent" || input.senderId !== ctx.agent.agentProfileId)
      ) {
        throw new ChatError("forbidden", "Agent run 只能以本 run 的分身身份发言");
      }
      // 发言资格与成员列表同源（`chat_effective_member`）：频道里没有 chat_member 行，
      // 只读成员表会让频道永远发不出消息；只读成员表也无法收回 Project 移除后的参与权。
      const sender = db
        .select({ memberId: chatEffectiveMember.memberId })
        .from(chatEffectiveMember)
        .where(
          and(
            eq(chatEffectiveMember.chatId, chatId),
            eq(chatEffectiveMember.projectId, current.projectId),
            eq(chatEffectiveMember.memberKind, input.senderKind),
            eq(chatEffectiveMember.memberId, input.senderId),
          ),
        )
        .get();
      if (!sender || (input.senderKind === "human" && input.senderId !== ctx.userId)) {
        throw new ChatError("not_found", "对话成员不存在");
      }
      // 裁定 d19：视图的 DM 分支不查 project_member，Agent 移出 Project 后旧 DM 行仍在视图里。
      // DM 里的 Agent 发送者必须仍是该 Project 成员，参与权不留在两处判定。
      if (input.senderKind === "agent" && current.kind === "dm") {
        const membership = db
          .select({ agentProfileId: projectMember.agentProfileId })
          .from(projectMember)
          .where(
            and(
              eq(projectMember.projectId, current.projectId),
              eq(projectMember.agentProfileId, input.senderId),
            ),
          )
          .get();
        if (!membership) throw new ChatError("not_found", "对话成员不存在");
      }
      const instance =
        input.senderKind === "agent"
          ? db
              .select()
              .from(agentInstance)
              .where(
                and(
                  eq(agentInstance.chatId, chatId),
                  eq(agentInstance.projectId, current.projectId),
                  eq(agentInstance.agentProfileId, input.senderId),
                ),
              )
              .get()
          : undefined;
      if (input.senderKind === "agent" && !instance)
        throw new ChatError("not_found", "Instance 不存在");
      return writeIdentity(
        ctx,
        {
          event: "message.sent",
          message: "消息已保存",
          projectId: current.projectId,
          chatId,
          ...(instance ? { instanceId: instance.id } : {}),
        },
        () => {
          const row = db
            .insert(message)
            .values({ id: newId(ID_PREFIXES.message), chatId, ...input })
            .returning()
            .get();
          db.update(chat)
            .set({ updatedAt: new Date() })
            .where(and(eq(chat.id, chatId), eq(chat.projectId, current.projectId)))
            .run();
          const saved = toMessage(row);
          if (input.senderKind === "human") appendHumanRunInput(saved, ctx);
          else appendOwnerAgentRunInput(saved, ctx);
          return saved;
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 取得某 Agent 在本对话里的 instance，没有就建一个。
 * 成员资格以 `chat_effective_member` 为准（裁定 d7）：instance 行在 Agent 被移出后物理保留，
 * 历史消息与 run 还要引用它，但「还在这对话里」只认视图。fanout 与消息发送共用这一个入口，
 * 避免两处各写一份参与权判定。
 */
export function ensureInstance(
  chatId: string,
  agentProfileId: string,
  ctx: ProjectContext,
): AgentInstance {
  const current = getChat(chatId, ctx);
  // Agent 只能给自己建 instance；替别的分身在同一个对话里准备运行不属于这次执行的范围。
  if (ctx.agent && ctx.agent.agentProfileId !== agentProfileId) throw new ProjectAccessError();
  const member = db
    .select({ memberId: chatEffectiveMember.memberId })
    .from(chatEffectiveMember)
    .where(
      and(
        eq(chatEffectiveMember.chatId, chatId),
        eq(chatEffectiveMember.projectId, current.projectId),
        eq(chatEffectiveMember.memberKind, "agent"),
        eq(chatEffectiveMember.memberId, agentProfileId),
      ),
    )
    .get();
  if (!member) throw new ChatError("not_found", "对话成员不存在");
  const existing = db
    .select()
    .from(agentInstance)
    .where(and(eq(agentInstance.chatId, chatId), eq(agentInstance.agentProfileId, agentProfileId)))
    .get();
  if (existing) return toInstance(existing);
  // 唯一索引 agent_instance_profile_chat_unique 兜住并发：两个唤醒抢同一 instance 时后者不写。
  db.insert(agentInstance)
    .values({
      id: newId(ID_PREFIXES.instance),
      agentProfileId,
      chatId,
      projectId: current.projectId,
    })
    .onConflictDoNothing()
    .run();
  const created = db
    .select()
    .from(agentInstance)
    .where(and(eq(agentInstance.chatId, chatId), eq(agentInstance.agentProfileId, agentProfileId)))
    .get();
  if (!created) throw new ChatError("conflict", "Instance 创建失败");
  return toInstance(created);
}

/**
 * 建群：Human 建立 Group、指定 Human 或 Agent 做所有者、给出初始成员集。
 * 行动者是 Agent 时能力表直接拒绝（`group_create` 是 never），进不到事务，
 * 所以这条路径上不存在「分身冒充 Human 建群」。
 */
export function createGroupChat(
  projectId: string,
  input: CreateGroupChatInput,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  assertChatCapability("group_create", actor);
  return sqlite
    .transaction(() => {
      assertProjectAccess(actor.ctx, projectId);
      for (const member of input.members) {
        if (member.kind === "agent") requireProjectAgent(projectId, member.id, actor.ctx);
        else requireUser(member.id);
      }
      // 契约只保证 Agent 所有者是成员之一；「属本 Project」要查库，在这里补上。
      if (input.initialOwner.kind === "agent")
        requireProjectAgent(projectId, input.initialOwner.id, actor.ctx);
      const chatId = newId(ID_PREFIXES.chat);
      return writeIdentity(
        actor.ctx,
        { event: "chat.group_created", message: "群组已创建", projectId, chatId },
        () => {
          const created = db
            .insert(chat)
            .values({
              id: chatId,
              projectId,
              kind: "group",
              title: input.title ?? null,
              ownerKind: input.initialOwner.kind,
              ownerId: input.initialOwner.id,
              wakePolicy: input.wakePolicy,
              governanceRevision: 0,
              createdBy: actor.ctx.userId,
            })
            .returning()
            .get();
          db.insert(chatMember)
            .values(
              input.members.map((member) => ({
                chatId,
                memberKind: member.kind,
                memberId: member.id,
              })),
            )
            .run();
          return toChat(created);
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 加成员。Human 成员档动作，Agent 一律 `forbidden`（裁定 d6 的入口先拦）。
 * 能力表的 `member` 档只回答「是不是人」，「是不是这条对话的成员」由运行时事实补上（裁定 d42）：
 * 被移出群的 Human 不再能调整成员，与会话标题的写入路径同码同文案。
 * 重复加同一成员是幂等成功：治理事实没有变化，就不推进 `governance_revision`；
 * 但调用方带的版本必须是当前版本，否则仍按并发冲突回绝，而不是悄悄放行一次过期写入。
 */
export function addGroupMember(
  chatId: string,
  member: ChatMemberInput,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableGroup(current);
      assertChatCapability("member_add", actor, chatGovernanceScope(current));
      if (actor.kind === "human" && !isEffectiveMember(actor, current))
        throw new ChatError("not_found", "对话成员不存在");
      if (member.kind === "agent") requireProjectAgent(current.projectId, member.id, actor.ctx);
      else requireUser(member.id);
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.member_added",
          message: "群组成员已添加",
          projectId: current.projectId,
          chatId,
        },
        () => {
          const inserted = db
            .insert(chatMember)
            .values({ chatId, memberKind: member.kind, memberId: member.id })
            .onConflictDoNothing()
            .returning()
            .get();
          if (!inserted) {
            if (current.governanceRevision !== expectedRevision)
              throw new ChatError("conflict", "群组已被并发修改，请刷新后重试");
            return current;
          }
          return applyGovernance(current, expectedRevision);
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 移出成员。裁定 d10 的两条处置在这里分开：
 * 仍有活跃 run 时以拒绝为准（`conflict`），连 pending 输入都不动——先取消再拒绝会让一次
 * 被拒的治理请求仍然产生副作用；只有没有活跃 run 时才把未下发的 `pending` 输入按
 * `membership_revoked` 取消，然后删成员行。
 * 当前所有者不能被直接移出：所有者身份由 `chat.owner_*` 独立表达，先换成别人再移。
 */
export function removeGroupMember(
  chatId: string,
  member: ChatMemberInput,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableGroup(current);
      assertChatCapability("member_remove", actor, chatGovernanceScope(current));
      if (actor.kind === "human" && !isEffectiveMember(actor, current))
        throw new ChatError("not_found", "对话成员不存在");
      const existing = db
        .select({ memberId: chatMember.memberId })
        .from(chatMember)
        .where(
          and(
            eq(chatMember.chatId, chatId),
            eq(chatMember.memberKind, member.kind),
            eq(chatMember.memberId, member.id),
          ),
        )
        .get();
      if (!existing) throw new ChatError("not_found", "对话成员不存在");
      if (current.owner.kind === member.kind && current.owner.id === member.id)
        throw new ChatError("conflict", "所有者不能被移出群组，请先变更所有者");
      const instanceIds = member.kind === "agent" ? instanceIdsOf(chatId, member.id) : [];
      const activeRun = activeRunOf(instanceIds);
      if (activeRun) throw new ChatError("conflict", "该成员仍有活跃运行，不能移出群组");
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.member_removed",
          message: "群组成员已移出",
          projectId: current.projectId,
          chatId,
        },
        () => {
          cancelPendingRunInputs(instanceIds);
          db.delete(chatMember)
            .where(
              and(
                eq(chatMember.chatId, chatId),
                eq(chatMember.memberKind, member.kind),
                eq(chatMember.memberId, member.id),
              ),
            )
            .run();
          return applyGovernance(current, expectedRevision);
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 项目级移除的对话侧处置（设计 §4.4 的第二、三步，裁定 d20 把这个单元放在 fanout 之后）。
 * 三件事都在调用方的事务里做，顺序就是「先断言、后动手」：
 *
 * 1. **阻断**：该 Agent 仍是某个普通 Group 的所有者时整次移除被拒（`conflict`）。
 *    所有者是 `chat.owner_*` 上的治理事实，移除另一个成员不应该替人换 owner；
 *    先 `setChatOwner` 再移除是唯一不让群组悬空所有者的路径（沿用 d6 的所有权语义，
 *    没有新增「项目移除自动换 owner」这类旁路）。
 * 2. **在途**：该 Agent 在本 Project 任意对话里有 `queued`/`running` 的 run 时整次移除被拒
 *    （`conflict`、断言 d10 的「拒绝优先于取消」）。pending 输入一条都不动：一次被拒的
 *    治理请求不能留下副作用，否则「移除失败但输入已取消」在历史里无法解释。
 * 3. **清理**：过了上面两关才动手——把该 Agent 在本 Project 全部 run 的 `pending` 输入按
 *    `membership_revoked` 取消（d11：只动未下发的），再物理删除它在普通 Group 的
 *    `chat_member` 行。频道没有成员行可删（成员是 Project 成员的派生事实，裁定 d7/d8），
 *    DM 的成员行保留（d14：历史仍可读；发言资格由 `sendMessage` 的 Project 成员判定收回，d19）。
 *    每删掉一行就推进那个群的 `governance_revision`（裁定 d30）：这次变化换掉了「谁能治理这个对话」的
 *    参与者，不推进的话移除前拿到的 `expectedRevision` 会在移除后仍然生效，陈旧 CAS 仍能落地。
 *    版本推进走 `applyGovernance` 的同一个收口点，只对真正删了行的群生效。
 */
export function revokeProjectAgentEnrollment(projectId: string, agentProfileId: string): void {
  const ownerGroups = db
    .select({ id: chat.id, title: chat.title })
    .from(chat)
    .where(
      and(
        eq(chat.projectId, projectId),
        eq(chat.kind, "group"),
        eq(chat.ownerKind, "agent"),
        eq(chat.ownerId, agentProfileId),
      ),
    )
    .all();
  if (ownerGroups.length > 0) {
    const names = ownerGroups
      .map((row: { id: string; title: string | null }) => row.title ?? row.id)
      .join("、");
    throw new ChatError("conflict", `该 Agent 仍是群组「${names}」的所有者，请先变更所有者`);
  }
  const instanceIds = projectInstanceIdsOf(projectId, agentProfileId);
  // 两个帮手的空集合行为一致（无 instance 就没有 run、也没有 run 输入），
  // 不能在这里提前返回：从未建过 instance 的 Agent 仍然可能有普通群的成员行要删。
  if (activeRunOf(instanceIds))
    throw new ChatError("conflict", "该 Agent 仍有活跃运行，不能移出 Project");
  cancelPendingRunInputs(instanceIds);
  // 只有普通 Group 有可删的成员行：频道的行由触发器与视图排除，DM 的行按 d14 保留。
  const groupIds = db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "group")))
    .all()
    .map((row: { id: string }) => row.id);
  if (groupIds.length === 0) return;
  const deleted = db
    .delete(chatMember)
    .where(
      and(
        inArray(chatMember.chatId, groupIds),
        eq(chatMember.memberKind, "agent"),
        eq(chatMember.memberId, agentProfileId),
      ),
    )
    .returning({ chatId: chatMember.chatId })
    .all() as { chatId: string }[];
  // 只有真正删掉成员行的群才换了一版：没被这次移除碰到的群不该因为别处的事动版本。
  for (const chatId of new Set(deleted.map((row) => row.chatId))) {
    const row = db.select().from(chat).where(eq(chat.id, chatId)).get();
    if (row) applyGovernance(toChat(row), "unconditional");
  }
}

/**
 * 换所有者。所有者档动作 + CAS：设计 4.3 要求 `expectedRevision`，过期版本一律 `conflict`。
 * 合法性按同一节：Agent 所有者必须是本对话的当前有效成员（读 `chat_effective_member`，
 * 所以项目移除后的 Agent 不能再被指定），Human 所有者必须是 `project.created_by`。
 */
export function setChatOwner(
  chatId: string,
  owner: ChatOwner,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableGroup(current);
      const scope = chatGovernanceScope(current);
      assertChatCapability("owner_change", actor, scope);
      if (owner.kind === "agent") {
        const member = db
          .select({ memberId: chatEffectiveMember.memberId })
          .from(chatEffectiveMember)
          .where(
            and(
              eq(chatEffectiveMember.chatId, chatId),
              eq(chatEffectiveMember.projectId, current.projectId),
              eq(chatEffectiveMember.memberKind, "agent"),
              eq(chatEffectiveMember.memberId, owner.id),
            ),
          )
          .get();
        if (!member) throw new ChatError("not_found", "新所有者不是该对话的成员");
      } else if (scope.projectCreatedBy !== owner.id) {
        throw new ChatError("forbidden", "Human 所有者必须是 Project 创建者");
      }
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.owner_changed",
          message: "群组所有者已变更",
          projectId: current.projectId,
          chatId,
        },
        () =>
          applyGovernance(current, expectedRevision, { ownerKind: owner.kind, ownerId: owner.id }),
        hooks,
      );
    })
    .immediate();
}
