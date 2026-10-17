import { eq } from "drizzle-orm";
import type { ProjectProfile, UpdateProjectProfileInput } from "../contracts/project-config";
import { db } from "../db";
import { projectProfile } from "../db/schema";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { writeIdentity } from "./identity-write";
import type { IdentityWriteHooks } from "./identity-write";

function toProjectProfile(row: typeof projectProfile.$inferSelect): ProjectProfile {
  return {
    projectId: row.projectId,
    ...(row.gitRemote === null ? {} : { gitRemote: row.gitRemote }),
    defaultBranch: row.defaultBranch,
    ...(row.workDirectory === null ? {} : { workDirectory: row.workDirectory }),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function getProjectProfile(projectId: string, ctx: ProjectContext): ProjectProfile {
  const project = assertProjectAccess(ctx, projectId);
  const row = db.select().from(projectProfile).where(eq(projectProfile.projectId, projectId)).get();
  return row
    ? toProjectProfile(row)
    : { projectId, defaultBranch: "main", updatedAt: project.updatedAt };
}

export function updateProjectProfile(
  projectId: string,
  input: UpdateProjectProfileInput,
  ctx: ProjectContext,
  hooks: IdentityWriteHooks = {},
): ProjectProfile {
  return writeIdentity(
    ctx,
    { event: "project_profile.updated", message: "Project 配置已更新", projectId },
    () => {
      assertProjectAccess(ctx, projectId);
      const updatedAt = new Date();
      const row = db
        .insert(projectProfile)
        .values({ projectId, ...input, updatedAt })
        .onConflictDoUpdate({ target: projectProfile.projectId, set: { ...input, updatedAt } })
        .returning()
        .get();
      return toProjectProfile(row);
    },
    hooks,
  );
}
