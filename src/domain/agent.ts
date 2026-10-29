import { and, asc, eq, sql } from "drizzle-orm";
import type {
  AgentProfile,
  CreateAgentProfileInput,
  ProjectMember,
  UpdateAgentProfileInput,
} from "../contracts/agent";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import { agentProfile, projectMember } from "../db/schema";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { revokeProjectAgentEnrollment } from "./chat";
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
    ...(row.jobTitle === null ? {} : { jobTitle: row.jobTitle }),
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
  // 一个事务把「参与权、在途运行、待发输入」三件事一起处理（设计 §4.4，裁定 d20）：
  // 断言的读（所有者、活跃 run）与后面的写必须原子，否则检查完到写入之间能挤进一条新的 run。
  sqlite
    .transaction(() => {
      assertProjectAccess(ctx, projectId);
      getAgentProfile(agentProfileId, ctx);
      const row = db
        .select({ agentProfileId: projectMember.agentProfileId })
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, projectId),
            eq(projectMember.agentProfileId, agentProfileId),
          ),
        )
        .get();
      // 幂等：已经不在 Project 的 Agent 再调一次是无副作用的成功——不写诊断事件、不碰对话。
      // 真正不存在的 profile 仍由上面的 getAgentProfile 给 `not_found`，拼错的 id 不会被静默吞掉。
      if (!row) return;
      writeIdentity(
        ctx,
        { event: "project_member.removed", message: "Project 成员已移除", projectId },
        () => {
          revokeProjectAgentEnrollment(projectId, agentProfileId);
          db.delete(projectMember)
            .where(
              and(
                eq(projectMember.projectId, projectId),
                eq(projectMember.agentProfileId, agentProfileId),
              ),
            )
            .run();
        },
        hooks,
      );
    })
    .immediate();
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
