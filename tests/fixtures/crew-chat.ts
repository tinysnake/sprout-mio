import { and, eq } from "drizzle-orm";
import type { Chat, ChatMemberInput } from "../../src/contracts/chat";
import { newId, ID_PREFIXES } from "../../src/contracts/ids";
import { db } from "../../src/db";
import { chat, chatMember, crewControl, project } from "../../src/db/schema";
import type { ChatActor } from "../../src/domain/chat-actor";
import { getChat, initializeCrewLead, readCrewLeadId, setCrewLead } from "../../src/domain/chat";

type LegacyCrewInput = {
  projectId: string;
  title?: string | null;
  members: ChatMemberInput[];
  initialOwner?: { kind: "human" | "agent"; id: string };
};

/**
 * 测试建 Crew：Project 已有 Crew 时复用它，把入参里的成员与 lead 写进去。
 * 旧用例以 Group 的方式描述成员集与 initialOwner，这里只保留其中 Crew 仍成立的部分：
 * lead 必须是 Agent，人类创建者始终是 owner。
 */
export function createCrewChat(projectId: string, input: LegacyCrewInput, actor: ChatActor): Chat {
  const owner = db
    .select({ createdBy: project.createdBy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  if (!owner) throw new Error("Project 不存在");
  const now = new Date();
  const chatId = newId(ID_PREFIXES.chat);
  db.insert(chat)
    .values({
      id: chatId,
      projectId,
      kind: "crew",
      title: input.title ?? null,
      ownerKind: "human",
      ownerId: owner.createdBy,
      createdBy: actor.ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(crewControl).values({ chatId, mode: "active", updatedAt: now }).run();
  const agents = input.members.filter((member) => member.kind === "agent");
  for (const member of input.members) {
    db.insert(chatMember)
      .values({ chatId, memberKind: member.kind, memberId: member.id })
      .onConflictDoNothing()
      .run();
  }
  const lead =
    input.initialOwner?.kind === "agent" ? input.initialOwner.id : (agents[0]?.id ?? undefined);
  if (lead && readCrewLeadId(chatId) === undefined) initializeCrewLead(chatId, lead);
  if (input.title !== undefined)
    db.update(chat).set({ title: input.title }).where(eq(chat.id, chatId)).run();
  return getChat(chatId, actor.ctx);
}

/** 旧用例把「换 Owner」当治理动作；Crew 上对应的是换 lead，人类 owner 不可换。 */
export function setChatOwnerCompat(
  chatId: string,
  owner: { kind: "human" | "agent"; id: string },
  expectedRevision: number,
  actor: ChatActor,
): Chat {
  if (owner.kind === "agent") return setCrewLead(chatId, owner.id, expectedRevision, actor);
  return seedLegacyHumanOwnerFixture(chatId, owner.id, expectedRevision, actor);
}

/** 仅为旧 Human owner 场景造数；不代表生产治理入口。 */
export function seedLegacyHumanOwnerFixture(
  chatId: string,
  humanId: string,
  expectedRevision: number,
  actor: ChatActor,
): Chat {
  db.update(chat)
    .set({
      ownerKind: "human",
      ownerId: humanId,
      governanceRevision: expectedRevision + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(chat.id, chatId), eq(chat.governanceRevision, expectedRevision)))
    .run();
  return getChat(chatId, actor.ctx);
}

/** 旧用例用 `createGroupChatInput.parse` 构造入参；Crew 的建群入口不再有公共契约，直接给对象。 */
export function crewInput(input: LegacyCrewInput): LegacyCrewInput {
  return input;
}
