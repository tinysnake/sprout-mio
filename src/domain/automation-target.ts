import { and, eq } from "drizzle-orm";
import type { AutomationAction } from "../contracts/automation";
import { db } from "../db";
import { agentProfile, chatEffectiveMember, projectMember } from "../db/schema";
import { assertProjectAccess, ProjectAccessError, type ProjectContext } from "./access";
import { getChat, createDirectChat, ChatError } from "./chat";
import { controlFor } from "./chat-schedule";

export function validateAutomationDmAgent(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
): string | null {
  assertProjectAccess(ctx, projectId);
  const member = db
    .select()
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.agentProfileId, agentProfileId)),
    )
    .get();
  if (!member) return "agent_not_participating";
  if (
    db.select().from(agentProfile).where(eq(agentProfile.id, agentProfileId)).get()?.purpose !==
    "worker"
  )
    return "agent_not_worker";
  return null;
}

export function resolveAutomationTarget(
  projectId: string,
  action: AutomationAction,
  ctx: ProjectContext,
): { chatId: string; agentProfileId: string } | { reason: string } {
  try {
    assertProjectAccess(ctx, projectId);
    if (action.kind === "dm_agent" && !action.chatId) {
      const reason = validateAutomationDmAgent(projectId, action.agentProfileId, ctx);
      if (reason) return { reason };
    }
    const targetChatId =
      action.kind === "dm_agent" && !action.chatId
        ? createDirectChat(projectId, action.agentProfileId, ctx).chat.id
        : action.chatId!;
    const current = getChat(targetChatId, ctx);
    if (current.projectId !== projectId) return { reason: "target_project_mismatch" };
    if (current.archivedAt) return { reason: "chat_archived" };
    if ((action.kind === "dm_agent") !== (current.kind === "dm"))
      return { reason: "target_kind_mismatch" };
    if (controlFor(current.id).mode !== "enabled") return { reason: "chat_stopped" };
    if (action.kind === "group_owner" && current.owner.kind !== "agent")
      return { reason: "owner_is_not_agent" };
    const agentProfileId = action.kind === "group_owner" ? current.owner.id : action.agentProfileId;
    const participant = db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.chatId, current.id),
          eq(chatEffectiveMember.projectId, projectId),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, agentProfileId),
        ),
      )
      .get();
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
    if (!participant || !member) return { reason: "agent_not_participating" };
    if (
      db.select().from(agentProfile).where(eq(agentProfile.id, agentProfileId)).get()?.purpose !==
      "worker"
    )
      return { reason: "agent_not_worker" };
    return { chatId: current.id, agentProfileId };
  } catch (error) {
    if (error instanceof ProjectAccessError || error instanceof ChatError)
      return { reason: "target_inaccessible" };
    throw error;
  }
}
