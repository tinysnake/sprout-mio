import { and, asc, eq, sql } from "drizzle-orm";
import type {
  AgentProfile,
  CreateAgentProfileInput,
  ProjectMember,
  UpdateAgentProfileInput,
} from "../contracts/agent";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db } from "../db";
import { agentProfile, projectMember } from "../db/schema";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

export class AgentError extends Error {
  constructor(
    readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

function toAgentProfile(row: typeof agentProfile.$inferSelect): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    harness: row.harness,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toProjectMember(row: typeof projectMember.$inferSelect): ProjectMember {
  return { ...row, addedAt: row.addedAt.toISOString() };
}

export function createAgentProfile(
  input: CreateAgentProfileInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): AgentProfile {
  return writeIdentity(
    ctx,
    { event: "agent_profile.created", message: "Agent profile 已创建" },
    () => {
      const row = db
        .insert(agentProfile)
        .values({ id: newId(ID_PREFIXES.agentProfile), ...input, createdBy: ctx.userId })
        .returning()
        .get();
      return toAgentProfile(row);
    },
    hooks,
  );
}

export function listAgentProfiles(ctx: ProjectContext): AgentProfile[] {
  return db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.createdBy, ctx.userId))
    .orderBy(asc(agentProfile.createdAt), asc(sql`rowid`))
    .all()
    .map(toAgentProfile);
}

export function getAgentProfile(id: string, ctx: ProjectContext): AgentProfile {
  const row = db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.id, id), eq(agentProfile.createdBy, ctx.userId)))
    .get();
  if (!row) throw new AgentError("not_found", "Agent profile 不存在");
  return toAgentProfile(row);
}

export function updateAgentProfile(
  id: string,
  input: UpdateAgentProfileInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): AgentProfile {
  return writeIdentity(
    ctx,
    { event: "agent_profile.updated", message: "Agent profile 已更新" },
    () => {
      getAgentProfile(id, ctx);
      const row = db
        .update(agentProfile)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(agentProfile.id, id), eq(agentProfile.createdBy, ctx.userId)))
        .returning()
        .get();
      if (!row) throw new AgentError("not_found", "Agent profile 不存在");
      return toAgentProfile(row);
    },
    hooks,
  );
}

export function addProjectMember(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): ProjectMember {
  return writeIdentity(
    ctx,
    { event: "project_member.added", message: "Project 成员已添加", projectId },
    () => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const row = db
        .insert(projectMember)
        .values({ projectId, agentProfileId, addedBy: ctx.userId })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!row) throw new AgentError("conflict", "Agent 已是 Project 成员");
      return toProjectMember(row);
    },
    hooks,
  );
}

export function removeProjectMember(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): void {
  writeIdentity(
    ctx,
    { event: "project_member.removed", message: "Project 成员已移除", projectId },
    () => {
      assertProjectAccess(ctx, projectId);
      const row = db
        .delete(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .returning()
        .get();
      if (!row) throw new AgentError("not_found", "Project 成员不存在");
    },
    hooks,
  );
}

export function listProjectMembers(projectId: string, ctx: ProjectContext): ProjectMember[] {
  assertProjectAccess(ctx, projectId);
  return db
    .select()
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId))
    .orderBy(asc(projectMember.addedAt), asc(sql`rowid`))
    .all()
    .map(toProjectMember);
}
