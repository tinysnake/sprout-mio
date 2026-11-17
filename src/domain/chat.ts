import { freezeCrewResources, hasCrewResourceResponsibilities } from "./crew-resource";
import { captureFeishuMessage } from "./feishu-delivery";
import { automationSourceFor } from "./automation-source";
import { assistantEventSummary } from "./assistant-display";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  CHAT_MESSAGE_PAGE_LIMIT_MAX,
  CHAT_MESSAGE_PAGE_SIZE,
  CHAT_TITLE_MAX_LENGTH,
  type AgentInstance,
  type Chat,
  type ChatDetail,
  type ChatMember,
  type ChatMemberInput,
  type MentionSpan,
  type Message,
  type MessageCursor,
  type MessageAttachmentSpan,
  type MessageWindow,
  type SendMessageInput,
} from "../contracts/chat";
import type { Attachment, NewAttachment } from "../contracts/attachment";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  assistantEvent,
  chat,
  chatEffectiveMember,
  chatMember,
  crewControl,
  delegation,
  message,
  project,
  projectMember,
  user,
} from "../db/schema";
import { assertProjectAccess, ProjectAccessError, readRunScope } from "./access";
import type { ProjectContext } from "./access";
import {
  collectProjectMemberRemovalBlockers,
  getAgentProfile,
  ProjectMemberRemovalBlockedError,
} from "./agent";
import { appendHumanRunInput } from "./agent-run";
import { readChatEffectiveMembers } from "./chat-members";
import { assertChatCapability } from "./chat-capabilities";
import type { ChatGovernanceScope } from "./chat-capabilities";
import type { ChatActor } from "./chat-actor";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";
import {
  mentionCandidatesFor,
  readMentionsFor,
  resolveMessageMentions,
  writeMessageMentions,
} from "./message-mention";
import {
  readAttachmentsFor,
  readAttachmentSpansFor,
  writeMessageAttachments,
} from "./message-attachment";
import {
  allocateAttachmentIds,
  discardAttachmentFiles,
  insertAttachments,
  rewriteAttachmentTokens,
  validateNewAttachments,
  writeAttachmentBytes,
} from "./attachment";

export class ChatError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

function toChat(row: typeof chat.$inferSelect): Chat {
  const control =
    row.kind === "crew"
      ? db
          .select({ mode: crewControl.mode })
          .from(crewControl)
          .where(eq(crewControl.chatId, row.id))
          .get()?.mode
      : undefined;
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.leadProfileId === null ? {} : { leadProfileId: row.leadProfileId }),
    ...(row.parentCrewChatId === null ? {} : { parentCrewChatId: row.parentCrewChatId }),
    crewEpoch: row.crewEpoch,
    ...(control === undefined ? {} : { control }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.toISOString() }),
    owner: { kind: row.ownerKind, id: row.ownerId },
    governanceRevision: row.governanceRevision,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInstance(row: typeof agentInstance.$inferSelect): AgentInstance {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

import type { MessageSkillSpan } from "../contracts/skill";
import { readSkillsFor, resolveMessageSkills, writeMessageSkills } from "./message-skill";

function toMessage(
  row: typeof message.$inferSelect,
  mentions: readonly MentionSpan[],
  skills: readonly MessageSkillSpan[],
  ctx: ProjectContext,
  attachmentSpans: readonly MessageAttachmentSpan[] = [],
  attachments: readonly Attachment[] = [],
): Message {
  const identity = {
    id: row.id,
    chatId: row.chatId,
    senderId: row.senderId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.senderKind === "delegation_event") {
    if (!row.delegationId) throw new Error("delegation_message_corrupt");
    const record = db.select().from(delegation).where(eq(delegation.id, row.delegationId)).get();
    if (!record) throw new Error("delegation_message_corrupt");
    const worker = db
      .select({ name: agentProfile.name })
      .from(agentProfile)
      .where(eq(agentProfile.id, record.workerProfileId))
      .get();
    return {
      ...identity,
      senderKind: "delegation_event",
      delegation: {
        delegationId: record.id,
        childChatId: record.childChatId,
        title: record.title,
        status: record.status,
        workerProfileName: worker?.name ?? "Agent",
        summary: record.terminalSummary,
        settledAt: (record.settledAt ?? row.createdAt).toISOString(),
      },
      mentions: [],
      skills: [],
      attachments: [],
      attachmentSpans: [],
    };
  }
  if (row.senderKind === "assistant_event") {
    const event = db
      .select()
      .from(assistantEvent)
      .where(eq(assistantEvent.id, row.assistantEventId!))
      .get()!;
    const fact = event.fact;
    if (fact.watchId) {
      let accessible = false;
      try {
        const watch = sqlite
          .prepare(
            "SELECT id FROM assistant_watch WHERE id=? AND assistant_chat_id=? AND consented_by=? AND revoked_at IS NULL",
          )
          .get(fact.watchId, row.chatId, ctx.userId);
        const target = getChat(fact.targetChatId, ctx);
        accessible =
          !!watch &&
          !event.suppressedAt &&
          !target.archivedAt &&
          target.projectId === fact.targetProjectId;
      } catch (error) {
        if (!(error instanceof ChatError || error instanceof ProjectAccessError)) throw error;
      }
      if (!accessible)
        return {
          ...identity,
          body: "关注已停止或来源已不可访问，原始记录不再展示。",
          senderKind: row.senderKind,
          nativeSource: {
            kind: "assistant_event",
            eventId: event.id,
            summary: "关注已停止或来源已不可访问。",
            projectId: fact.targetProjectId,
            chatId: fact.targetChatId,
          },
          mentions: [],
          skills: [],
          attachments: [],
          attachmentSpans: [],
        };
    }
    return {
      ...identity,
      senderKind: row.senderKind,
      nativeSource: {
        kind: "assistant_event",
        eventId: row.assistantEventId!,
        summary: assistantEventSummary(fact, event.eventKey, event.id),
        projectId: fact.targetProjectId,
        chatId: fact.targetChatId,
        ...(fact.runId ? { runId: fact.runId } : {}),
      },
      mentions: [],
      skills: [],
      attachments: [],
      attachmentSpans: [],
    };
  }
  if (row.senderKind === "assistant_work")
    return {
      ...identity,
      senderKind: row.senderKind,
      nativeSource: { kind: "assistant_work", proposalId: row.assistantProposalId! },
      mentions: [],
      skills: [],
      attachments: [],
      attachmentSpans: [],
    };
  if (row.senderKind === "automation") {
    if (!row.automationTriggerId) throw new Error("automation_message_corrupt");
    return {
      ...identity,
      senderKind: "automation",
      automationSource: automationSourceFor(row.automationTriggerId),
      mentions: [],
      skills: [],
      attachments: [],
      attachmentSpans: [],
    };
  }
  return {
    ...identity,
    senderKind: row.senderKind,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    mentions: mentions.map((span) => ({ ...span })),
    skills: skills.map((span) => ({ ...span })),
    attachments: attachments.map((item) => ({ ...item })),
    attachmentSpans: attachmentSpans.map((span) => ({ ...span })),
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
 * 成员与 lead 治理只对 Crew 生效。DM 的成员由创建时固定，没有可调整的成员集。
 */
function assertGovernableCrew(row: Chat): void {
  if (row.kind !== "crew") throw new ChatError("forbidden", "只有 Crew 可以调整成员与 lead");
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

function requireProjectAgent(projectId: string, agentProfileId: string, ctx: ProjectContext): void {
  if (getAgentProfile(agentProfileId, ctx).purpose !== "worker")
    throw new ChatError("forbidden", "Assistant 只能加入 Human DM");
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
      if (getAgentProfile(agentProfileId, ctx).purpose === "assistant" && ctx.agent)
        throw new ChatError("forbidden", "Assistant DM 只能由 Human 创建");
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

export function listMessages(
  chatId: string,
  ctx: ProjectContext,
  after?: MessageCursor,
): Message[] {
  return readMessages(chatId, ctx, { after }).messages;
}

/** 一次消息读的三种方向；`before` 与 `after` 不同时出现由契约边界拒绝。 */
export type MessageWindowQuery = {
  before?: MessageCursor;
  after?: MessageCursor;
  limit?: number;
};

/**
 * 一次消息读：不传方向时读最新一页；`before` 向更早翻页；`after` 读增量。
 * 页大小只在这里收口：边界给的 `limit` 与默认值都受同一个上限约束。
 * 空窗口回显请求的游标，客户端可以无脑存下返回值。
 */
export function listMessageWindow(
  chatId: string,
  ctx: ProjectContext,
  query: MessageWindowQuery = {},
): MessageWindow {
  const limit = Math.min(query.limit ?? CHAT_MESSAGE_PAGE_SIZE, CHAT_MESSAGE_PAGE_LIMIT_MAX);
  const page = readMessages(chatId, ctx, { after: query.after, before: query.before, limit });
  return {
    messages: page.messages,
    tailCursor: page.tail ?? query.after ?? query.before ?? null,
    olderCursor: page.head,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  };
}

/**
 * 游标解析只在这里做一次：`<createdAt 秒>:<rowid>`。格式不合法不静默退回整段读，
 * 否则调用方拿到全量也不报错，增量读就悄悄退化成旧行为。
 */
function parseMessageCursor(cursor: MessageCursor): { createdAt: Date; rowId: number } {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new ChatError("conflict", "消息游标格式无效");
  return { createdAt: new Date(Number(match[1]) * 1000), rowId: Number(match[2]) };
}

type MessageRow = { entry: typeof message.$inferSelect; rowId: number };

/** 游标就是领域查询的排序键，单用时间戳会漏掉同一秒里后面的消息。 */
function rowCursor(row: MessageRow): MessageCursor {
  return `${Math.floor(row.entry.createdAt.getTime() / 1000)}:${row.rowId}`;
}

/**
 * 消息只追加不改写，所以读窗口只需要一个边界；排序与游标同键 `(createdAt, rowid)`。
 * 不带 `after` 时从新往旧读一页（多读一条判定 `hasOlder`），带 `after` 时往后读一页
 * （同样多读一条判定 `hasNewer`，客户端据此知道还要不要"回到最新"再读一次）。
 */
function readMessages(
  chatId: string,
  ctx: ProjectContext,
  query: { after?: MessageCursor; before?: MessageCursor; limit?: number | null },
): {
  messages: Message[];
  head: MessageCursor | null;
  tail: MessageCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
} {
  const current = getChat(chatId, ctx);
  const newer = query.after !== undefined;
  const limit = query.limit ?? null;
  const cursor =
    query.after !== undefined
      ? parseMessageCursor(query.after)
      : query.before !== undefined
        ? parseMessageCursor(query.before)
        : null;
  const select = db
    .select({ entry: message, rowId: sql<number>`${message}.rowid` })
    .from(message)
    .innerJoin(chat, eq(chat.id, message.chatId))
    .where(
      and(
        eq(message.chatId, chatId),
        eq(chat.projectId, current.projectId),
        ...(cursor === null
          ? []
          : newer
            ? [
                or(
                  gt(message.createdAt, cursor.createdAt),
                  and(
                    eq(message.createdAt, cursor.createdAt),
                    sql`${message}.rowid > ${cursor.rowId}`,
                  ),
                ),
              ]
            : [
                or(
                  lt(message.createdAt, cursor.createdAt),
                  and(
                    eq(message.createdAt, cursor.createdAt),
                    sql`${message}.rowid < ${cursor.rowId}`,
                  ),
                ),
              ]),
      ),
    )
    .orderBy(
      ...(newer
        ? [asc(message.createdAt), asc(sql`${message}.rowid`)]
        : [desc(message.createdAt), desc(sql`${message}.rowid`)]),
    );
  // 两个方向都多读一条才知道边界之外还有没有消息：往旧读用来判 `hasOlder`，
  // 往后读用来判 `hasNewer`。不传 limit 的整段读（远端 Agent 组装提示）保持原样，不加隐式上限。
  const bounded = limit === null ? select : select.limit(limit + 1);
  const rows = bounded.all() as MessageRow[];
  const overflows = limit !== null && rows.length > limit;
  const hasOlder = overflows && !newer;
  const hasNewer = overflows && newer;
  const kept = overflows && limit !== null ? rows.slice(0, limit) : rows;
  // 从新往旧读到的顺序是倒的，按时间升序交给上层。
  const ordered = newer ? kept : kept.reverse();
  const first = ordered.at(0);
  const last = ordered.at(-1);
  // mention 一次读一批再按 messageId 归并，不按消息逐条查。
  const mentions = readMentionsFor(
    chatId,
    ordered.map((row) => row.entry.id),
  );
  const skills = readSkillsFor(
    chatId,
    ordered.map((row) => row.entry.id),
  );
  const attachmentSpans = readAttachmentSpansFor(
    chatId,
    ordered.map((row) => row.entry.id),
  );
  const attachments = readAttachmentsFor(
    chatId,
    ordered.map((row) => row.entry.id),
  );
  return {
    messages: ordered.map((row) =>
      toMessage(
        row.entry,
        mentions.get(row.entry.id) ?? [],
        skills.get(row.entry.id) ?? [],
        ctx,
        attachmentSpans.get(row.entry.id) ?? [],
        attachments.get(row.entry.id) ?? [],
      ),
    ),
    head: first === undefined ? null : rowCursor(first),
    tail: last === undefined ? null : rowCursor(last),
    hasOlder,
    hasNewer,
  };
}

export function sendMessage(
  chatId: string,
  input: SendMessageInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
  newAttachments: readonly NewAttachment[] = [],
): Message {
  // 附件字节在事务里写盘；事务回滚时按这份清单删掉，不留没有行指向的文件。
  const writtenFiles: string[] = [];
  const commitMessage = sqlite.transaction(() => {
    const current = getChat(chatId, ctx);
    if (current.kind === "crew" && current.control === "stopped" && input.senderKind === "human")
      throw new ChatError("conflict", "Crew 已停止接入新消息");
    if (input.senderKind !== "human" && input.senderKind !== "agent")
      throw new ChatError("forbidden", "来源消息只能由可信领域入口创建");
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
        // 引用先把本地 token 换成真实附件 id：正文与 span 从此对齐，渲染与投递都按 span 定位。
        // 正文里出现没随这次提交带上来的 token 会被直接拒掉，不留一条指向不存在附件的正文。
        validateNewAttachments(newAttachments);
        const idByLocalId = allocateAttachmentIds(newAttachments);
        const rewritten = rewriteAttachmentTokens(input.body, idByLocalId);
        // 点名与技能都从最终正文解析：存下去的就是它，解析结果不会与落库正文错位。
        const members = readChatEffectiveMembers(chatId, current.projectId);
        const spans = resolveMessageMentions({
          body: rewritten.body,
          candidates: mentionCandidatesFor(members),
        });
        const row = db
          .insert(message)
          .values({ id: newId(ID_PREFIXES.message), chatId, ...input, body: rewritten.body })
          .returning()
          .get();
        // 同一条 message 与它的 mention 行在同一个事务里落库：外键指向刚插入的那一行。
        writeMessageMentions(chatId, row.id, spans);
        const skills = resolveMessageSkills(rewritten.body);
        writeMessageSkills(chatId, row.id, skills);
        const records = insertAttachments({
          chatId,
          messageId: row.id,
          createdBy: ctx.userId,
          list: newAttachments,
          idByLocalId,
        });
        writtenFiles.push(...writeAttachmentBytes({ list: newAttachments, idByLocalId }));
        writeMessageAttachments(chatId, row.id, rewritten.spans);
        // 会话的「最后消息时间」必须就是这条消息的时间：再读一次时钟会跨秒，
        // 列表显示的时间就会和消息本身差一秒（k-acceptance 会判不一致）。
        db.update(chat)
          .set({ updatedAt: row.createdAt })
          .where(and(eq(chat.id, chatId), eq(chat.projectId, current.projectId)))
          .run();
        const saved = toMessage(row, spans, skills, ctx, rewritten.spans, records);
        // Agent 之间的消息不再级联唤醒：Worker 的输入来自 lead 的显式委派，不是群里的点名。
        if (input.senderKind === "human") appendHumanRunInput(saved, ctx);
        captureFeishuMessage(row.id, row.createdAt);
        return saved;
      },
      hooks,
    );
  });
  let saved: Message;
  try {
    saved = commitMessage.immediate();
  } catch (error) {
    discardAttachmentFiles(writtenFiles);
    throw error;
  }
  return saved;
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
 * Project 的 Crew：一个 Project 恰好一条，由 Project 创建时饥饿创建，title 取 Project 名，
 * 所有者是 Project 的人类创建者，成员集独立于 Project（创建者显式入列）。
 * 幂等：唯一索引兜住并发，已存在就返回那一条。
 */
export function ensureProjectCrew(projectId: string): string {
  const existing = db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "crew")))
    .get();
  if (existing) return existing.id;
  const parent = db.select().from(project).where(eq(project.id, projectId)).get();
  if (!parent) throw new ChatError("not_found", "Project 不存在");
  const chatId = newId(ID_PREFIXES.chat);
  const now = new Date();
  db.insert(chat)
    .values({
      id: chatId,
      projectId,
      kind: "crew",
      title: parent.name,
      ownerKind: "human",
      ownerId: parent.createdBy,
      governanceRevision: 0,
      createdBy: parent.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const created = db
    .select()
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "crew")))
    .get();
  if (!created) throw new ChatError("conflict", "Crew 创建失败");
  if (created.id === chatId) {
    db.insert(crewControl).values({ chatId, mode: "active" }).onConflictDoNothing().run();
    db.insert(chatMember)
      .values({ chatId, memberKind: "human", memberId: parent.createdBy })
      .onConflictDoNothing()
      .run();
  }
  return created.id;
}

/** 当前 lead；没有 lead 时返回 undefined（Crew 建好但首个 Agent 还没加入）。 */
export function readCrewLeadId(chatId: string): string | undefined {
  return (
    db
      .select({ leadProfileId: chat.leadProfileId })
      .from(chat)
      .where(and(eq(chat.id, chatId), eq(chat.kind, "crew")))
      .get()?.leadProfileId ?? undefined
  );
}

/**
 * 首个加入 Project 的 Agent 成为 Crew 的 lead。只在 lead 为空且 epoch 为零时生效：
 * 单条 UPDATE 的 WHERE 就是并发边界，两个 Agent 同时加入只有先到的那个写进去。
 * 创建后再移除 lead 不会触发重新初始化，lead 只能由人类显式改任。
 */
export function initializeCrewLead(chatId: string, agentProfileId: string): void {
  db.update(chat)
    .set({
      leadProfileId: agentProfileId,
      crewEpoch: sql`${chat.crewEpoch} + 1`,
      governanceRevision: sql`${chat.governanceRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chat.id, chatId),
        eq(chat.kind, "crew"),
        isNull(chat.leadProfileId),
        eq(chat.crewEpoch, 0),
      ),
    )
    .run();
}

/**
 * 加成员。Human 成员档动作，Agent 一律 forbidden。Agent 必须已是本 Project 成员且 purpose worker，
 * 人类只能是 Project 创建者（Crew 成员集不自动继承 Project 的其他人）。
 * 重复加同一成员是幂等成功；首次初始化（epoch 为零且无 lead）时才会自动指定 lead。
 */
export function addCrewMember(
  chatId: string,
  member: ChatMemberInput,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableCrew(current);
      assertChatCapability("member_add", actor, chatGovernanceScope(current));
      if (actor.kind === "human" && !isEffectiveMember(actor, current))
        throw new ChatError("not_found", "对话成员不存在");
      if (member.kind === "agent") requireProjectAgent(current.projectId, member.id, actor.ctx);
      else if (member.id !== chatGovernanceScope(current).projectCreatedBy)
        throw new ChatError("forbidden", "Crew 只接受 Project 创建者作为人类成员");
      else requireUser(member.id);
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.member_added",
          message: "Crew 成员已添加",
          projectId: current.projectId,
          chatId,
        },
        () => {
          if (current.governanceRevision !== expectedRevision)
            throw new ChatError("conflict", "Crew 已被并发修改，请刷新后重试");
          const inserted = db
            .insert(chatMember)
            .values({ chatId, memberKind: member.kind, memberId: member.id })
            .onConflictDoNothing()
            .returning()
            .get();
          if (
            member.kind === "agent" &&
            current.leadProfileId === undefined &&
            current.crewEpoch === 0
          ) {
            initializeCrewLead(chatId, member.id);
            return getChat(chatId, actor.ctx);
          }
          return inserted ? applyGovernance(current, expectedRevision) : current;
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 移出成员。当前 lead 不能被直接移出：先改任 lead，再移出。
 * 仍有活跃 run 时拒绝，连 pending 输入都不动；没有活跃 run 才取消未下发输入并删成员行。
 */
export function removeCrewMember(
  chatId: string,
  member: ChatMemberInput,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableCrew(current);
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
        throw new ChatError("conflict", "Project 创建者不能被移出 Crew");
      if (member.kind === "agent" && current.leadProfileId === member.id)
        throw new ChatError("conflict", "当前 lead 不能被移出，请先改任 lead");
      if (member.kind === "agent") assertCrewAgentResponsibilitiesEnded(current, member.id);
      const instanceIds = member.kind === "agent" ? instanceIdsOf(chatId, member.id) : [];
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.member_removed",
          message: "Crew 成员已移出",
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
 * 常规移除路径：调用方的移除事务先聚合四类责任，任一命中都抛结构化错误，清理前零写入。
 */
export function revokeProjectAgentEnrollment(projectId: string, agentProfileId: string): void {
  const blockers = collectProjectMemberRemovalBlockers(projectId, agentProfileId);
  if (blockers.length)
    throw new ProjectMemberRemovalBlockedError({ projectId, agentProfileId, blockers });
  for (const crew of db
    .select()
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "crew")))
    .all()) {
    if (hasCrewResourceResponsibilities(crew.id, agentProfileId))
      throw new ChatError("conflict", "Crew 资源责任尚未结束");
  }
  revokeProjectAgentEnrollmentUnchecked(projectId, agentProfileId);
}

/**
 * 参与权剥夺本体：沿用 P5a 取消 pending 输入、删除普通 Group 成员并推进 governance_revision。
 * Public Channel 参与权随 Project 成员派生；DM 成员行保留，归档由 Agent 域在同事务内处理。
 *
 * 只由两种调用方使用：常规移除（刚复查过零阻塞）与强制移除（已逐项善后）。强制移除在无法
 * 确认撤权时会刻意留下 fencing 租约，所以这里不能复查四类责任，否则「保留待处理占用」与
 * 「移除必须完成」互相矛盾。
 */
export function revokeProjectAgentEnrollmentUnchecked(
  projectId: string,
  agentProfileId: string,
): void {
  const instanceIds = projectInstanceIdsOf(projectId, agentProfileId);
  for (const crew of db
    .select()
    .from(chat)
    .where(
      and(
        eq(chat.projectId, projectId),
        eq(chat.kind, "crew"),
        eq(chat.leadProfileId, agentProfileId),
      ),
    )
    .all())
    freezeCrewResources({ crewChatId: crew.id }, "lead_removed");
  for (const run of db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.projectId, projectId), inArray(agentRun.instanceId, instanceIds)))
    .all())
    freezeCrewResources({ runId: run.id }, "member_removed");
  // 两个帮手的空集合行为一致（无 instance 就没有 run、也没有 run 输入），
  // 不能在这里提前返回：从未建过 instance 的 Agent 仍然可能有普通群的成员行要删。
  cancelPendingRunInputs(instanceIds);
  // Crew 有可删的成员行；DM 的行按 d14 保留，供历史读取。
  const crewIds = db
    .select({ id: chat.id })
    .from(chat)
    .where(and(eq(chat.projectId, projectId), eq(chat.kind, "crew")))
    .all()
    .map((row: { id: string }) => row.id);
  if (crewIds.length === 0) return;
  const deleted = db
    .delete(chatMember)
    .where(
      and(
        inArray(chatMember.chatId, crewIds),
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

function assertCrewAgentResponsibilitiesEnded(current: Chat, agentProfileId: string): void {
  if (hasCrewResourceResponsibilities(current.id, agentProfileId))
    throw new ChatError("conflict", "Crew 资源请求、grant 或排空责任尚未结束");
  const blockers = collectProjectMemberRemovalBlockers(
    current.projectId,
    agentProfileId,
    current.id,
  );
  if (blockers.length)
    throw new ProjectMemberRemovalBlockedError({
      projectId: current.projectId,
      agentProfileId,
      blockers,
    });
}

/** Human owner 通过治理版本控制 Crew 的接入开关；已有 run 保留执行权。 */
export function setCrewMode(
  chatId: string,
  mode: "active" | "stopped",
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      assertGovernableCrew(current);
      if (
        actor.kind !== "human" ||
        actor.ctx.agent ||
        current.owner.kind !== "human" ||
        actor.userId !== current.owner.id ||
        actor.ctx.userId !== actor.userId
      )
        throw new ChatError("forbidden", "只有 Human owner 可以控制 Crew");
      if (mode !== "active" && mode !== "stopped")
        throw new ChatError("conflict", "Crew mode 无效");
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.crew_mode_changed",
          message: "Crew 接入状态已变更",
          projectId: current.projectId,
          chatId,
        },
        () => {
          const updated = applyGovernance(current, expectedRevision);
          db.insert(crewControl)
            .values({ chatId, mode, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: crewControl.chatId,
              set: { mode, updatedAt: new Date() },
            })
            .run();
          if (mode === "stopped") freezeCrewResources({ crewChatId: chatId }, "crew_stopped");
          return { ...updated, control: mode };
        },
        hooks,
      );
    })
    .immediate();
}

/**
 * 改任 lead。所有者档动作 + CAS：候选必须是当前有效的 Agent 成员。
 * 每次改任都推进 `crew_epoch`：执行中的委派与资源授权按 epoch 失效，旧 epoch 的结果保留可审计。
 */
export function setCrewLead(
  chatId: string,
  leadProfileId: string,
  expectedRevision: number,
  actor: ChatActor,
  hooks: IdentityWriteHooks = {},
): Chat {
  return sqlite
    .transaction(() => {
      const current = getChat(chatId, actor.ctx);
      if (current.kind !== "crew") throw new ChatError("forbidden", "只有 Crew 有 lead");
      assertChatCapability("lead_change", actor, chatGovernanceScope(current));
      const member = db
        .select({ memberId: chatEffectiveMember.memberId })
        .from(chatEffectiveMember)
        .where(
          and(
            eq(chatEffectiveMember.chatId, chatId),
            eq(chatEffectiveMember.projectId, current.projectId),
            eq(chatEffectiveMember.memberKind, "agent"),
            eq(chatEffectiveMember.memberId, leadProfileId),
          ),
        )
        .get();
      if (!member) throw new ChatError("not_found", "新 lead 不是该 Crew 的成员");
      if (current.leadProfileId)
        assertCrewAgentResponsibilitiesEnded(current, current.leadProfileId);
      return writeIdentity(
        actor.ctx,
        {
          event: "chat.crew_lead_changed",
          message: "Crew lead 已变更",
          projectId: current.projectId,
          chatId,
        },
        () => {
          const updated = db
            .update(chat)
            .set({
              leadProfileId,
              crewEpoch: sql`${chat.crewEpoch} + 1`,
              governanceRevision: current.governanceRevision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chat.id, chatId),
                eq(chat.projectId, current.projectId),
                eq(chat.governanceRevision, expectedRevision),
              ),
            )
            .returning()
            .get();
          if (!updated) throw new ChatError("conflict", "Crew 已被并发修改，请刷新后重试");
          return toChat(updated);
        },
        hooks,
      );
    })
    .immediate();
}
