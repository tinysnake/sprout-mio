import { and, eq } from "drizzle-orm";
import type { Project } from "../contracts/project";
import { db } from "../db";
import { project } from "../db/schema";
import type { ProjectContext } from "./project";

export type { ProjectContext } from "./project";

export class ProjectAccessError extends Error {
  readonly code = "not_found";

  constructor(code: "not_found" = "not_found") {
    super("对象不存在");
    this.name = "ProjectAccessError";
    this.code = code;
  }
}

export function assertProjectAccess(ctx: ProjectContext, projectId: string): Project {
  const row = db
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.createdBy, ctx.userId)))
    .get();
  if (!row) throw new ProjectAccessError();
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
