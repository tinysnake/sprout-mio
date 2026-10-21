import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  AgentInstance,
  Chat,
  ChatMember,
  DirectChat,
  Message,
  SendMessageInput,
} from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import { agentInstance, chat, chatMember, message, projectMember } from "../db/schema";
import { assertProjectAccess, ProjectAccessError } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile } from "./agent";
import { appendHumanRunInput } from "./agent-run";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

export class ChatError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
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

export function createDirectChat(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): DirectChat {
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
            .values({ id: chatId, projectId, kind: "dm", createdBy: ctx.userId })
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
  return toChat(row);
}

export function listChatMembers(chatId: string, ctx: ProjectContext): ChatMember[] {
  const current = getChat(chatId, ctx);
  return db
    .select({ member: chatMember })
    .from(chatMember)
    .innerJoin(chat, eq(chat.id, chatMember.chatId))
    .where(and(eq(chat.id, chatId), eq(chat.projectId, current.projectId)))
    .orderBy(asc(chatMember.addedAt), asc(sql`${chatMember}.rowid`))
    .all()
    .map(({ member }: { member: typeof chatMember.$inferSelect }) => ({
      ...member,
      addedAt: member.addedAt.toISOString(),
    }));
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
      const sender = db
        .select({ member: chatMember })
        .from(chatMember)
        .innerJoin(chat, eq(chat.id, chatMember.chatId))
        .where(
          and(
            eq(chat.id, chatId),
            eq(chat.projectId, current.projectId),
            eq(chatMember.memberKind, input.senderKind),
            eq(chatMember.memberId, input.senderId),
          ),
        )
        .get();
      if (!sender || (input.senderKind === "human" && input.senderId !== ctx.userId)) {
        throw new ChatError("not_found", "对话成员不存在");
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
          return saved;
        },
        hooks,
      );
    })
    .immediate();
}
