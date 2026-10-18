import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  AgentInstance,
  Conversation,
  ConversationMember,
  DirectConversation,
  Message,
  SendMessageInput,
} from "../contracts/conversation";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentInstance,
  conversation,
  conversationMember,
  message,
  projectMember,
} from "../db/schema";
import { assertProjectAccess, ProjectAccessError } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile } from "./agent";
import { appendHumanRunInput } from "./agent-run";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

export class ConversationError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ConversationError";
  }
}

function toConversation(row: typeof conversation.$inferSelect): Conversation {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt.toISOString() }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInstance(row: typeof agentInstance.$inferSelect): AgentInstance {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toMessage(row: typeof message.$inferSelect): Message {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export function createDirectConversation(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): DirectConversation {
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
      if (!member) throw new ConversationError("not_found", "Project 成员不存在");
      const existing = db
        .select({ conversation, instance: agentInstance })
        .from(conversation)
        .innerJoin(
          agentInstance,
          and(
            eq(agentInstance.conversationId, conversation.id),
            eq(agentInstance.projectId, conversation.projectId),
          ),
        )
        .where(
          and(
            eq(conversation.projectId, projectId),
            eq(conversation.kind, "dm"),
            eq(conversation.createdBy, ctx.userId),
            eq(agentInstance.agentProfileId, agentProfileId),
          ),
        )
        .orderBy(asc(conversation.createdAt), asc(conversation.id))
        .get();
      if (existing)
        return {
          conversation: toConversation(existing.conversation),
          instance: toInstance(existing.instance),
        };
      const conversationId = newId(ID_PREFIXES.conversation);
      const instanceId = newId(ID_PREFIXES.instance);
      return writeIdentity(
        ctx,
        {
          event: "conversation.created",
          message: "DM 已创建",
          projectId,
          conversationId,
          instanceId,
        },
        () => {
          const created = db
            .insert(conversation)
            .values({ id: conversationId, projectId, kind: "dm", createdBy: ctx.userId })
            .returning()
            .get();
          db.insert(conversationMember)
            .values([
              { conversationId, memberKind: "human", memberId: ctx.userId },
              { conversationId, memberKind: "agent", memberId: agentProfileId },
            ])
            .run();
          const instance = db
            .insert(agentInstance)
            .values({ id: instanceId, agentProfileId, conversationId, projectId })
            .returning()
            .get();
          return { conversation: toConversation(created), instance: toInstance(instance) };
        },
        hooks,
      );
    })
    .immediate();
}

export function listConversations(projectId: string, ctx: ProjectContext): Conversation[] {
  assertProjectAccess(ctx, projectId);
  return db
    .select()
    .from(conversation)
    .where(eq(conversation.projectId, projectId))
    .orderBy(desc(conversation.updatedAt), desc(sql`rowid`))
    .all()
    .map(toConversation);
}

export function getConversation(conversationId: string, ctx: ProjectContext): Conversation {
  const row = db.select().from(conversation).where(eq(conversation.id, conversationId)).get();
  if (!row) throw new ProjectAccessError();
  assertProjectAccess(ctx, row.projectId);
  return toConversation(row);
}

export function listConversationMembers(
  conversationId: string,
  ctx: ProjectContext,
): ConversationMember[] {
  const current = getConversation(conversationId, ctx);
  return db
    .select({ member: conversationMember })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .where(and(eq(conversation.id, conversationId), eq(conversation.projectId, current.projectId)))
    .orderBy(asc(conversationMember.addedAt), asc(sql`${conversationMember}.rowid`))
    .all()
    .map(({ member }: { member: typeof conversationMember.$inferSelect }) => ({
      ...member,
      addedAt: member.addedAt.toISOString(),
    }));
}

export function listInstancesForConversation(
  conversationId: string,
  ctx: ProjectContext,
): AgentInstance[] {
  const current = getConversation(conversationId, ctx);
  return db
    .select()
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.conversationId, conversationId),
        eq(agentInstance.projectId, current.projectId),
      ),
    )
    .orderBy(asc(agentInstance.createdAt), asc(sql`rowid`))
    .all()
    .map(toInstance);
}

export function getInstance(instanceId: string, ctx: ProjectContext): AgentInstance {
  const row = db.select().from(agentInstance).where(eq(agentInstance.id, instanceId)).get();
  if (!row) throw new ProjectAccessError();
  const current = getConversation(row.conversationId, ctx);
  if (current.projectId !== row.projectId) throw new ProjectAccessError();
  return toInstance(row);
}

export function listMessages(conversationId: string, ctx: ProjectContext): Message[] {
  const current = getConversation(conversationId, ctx);
  return db
    .select({ entry: message })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(conversation.projectId, current.projectId),
      ),
    )
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .all()
    .map(({ entry }: { entry: typeof message.$inferSelect }) => toMessage(entry));
}

export function sendMessage(
  conversationId: string,
  input: SendMessageInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): Message {
  return sqlite
    .transaction(() => {
      const current = getConversation(conversationId, ctx);
      const sender = db
        .select({ member: conversationMember })
        .from(conversationMember)
        .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
        .where(
          and(
            eq(conversation.id, conversationId),
            eq(conversation.projectId, current.projectId),
            eq(conversationMember.memberKind, input.senderKind),
            eq(conversationMember.memberId, input.senderId),
          ),
        )
        .get();
      if (!sender || (input.senderKind === "human" && input.senderId !== ctx.userId)) {
        throw new ConversationError("not_found", "对话成员不存在");
      }
      const instance =
        input.senderKind === "agent"
          ? db
              .select()
              .from(agentInstance)
              .where(
                and(
                  eq(agentInstance.conversationId, conversationId),
                  eq(agentInstance.projectId, current.projectId),
                  eq(agentInstance.agentProfileId, input.senderId),
                ),
              )
              .get()
          : undefined;
      if (input.senderKind === "agent" && !instance)
        throw new ConversationError("not_found", "Instance 不存在");
      return writeIdentity(
        ctx,
        {
          event: "message.sent",
          message: "消息已保存",
          projectId: current.projectId,
          conversationId,
          ...(instance ? { instanceId: instance.id } : {}),
        },
        () => {
          const row = db
            .insert(message)
            .values({ id: newId(ID_PREFIXES.message), conversationId, ...input })
            .returning()
            .get();
          db.update(conversation)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(conversation.id, conversationId),
                eq(conversation.projectId, current.projectId),
              ),
            )
            .run();
          const saved = toMessage(row);
          if (input.senderKind === "human") appendHumanRunInput(saved, ctx);
          return saved;
        },
        hooks,
      );
    })
    .immediate();
}
