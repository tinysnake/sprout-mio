import { and, desc, eq, sql } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { CreateProjectInput, Project, UpdateProjectInput } from "../contracts/project";
import { db, sqlite } from "../db";
import { diagnosticEvent, project } from "../db/schema";

/** 调用者身份与请求关联在边界确定，业务服务不读取 HTTP 概念。 */
export type ProjectContext = { userId: string; requestId: string };

/** 业务服务只登记调用方可以据以行动的失败，其余错误由边界映射为 internal。 */
export type ProjectErrorCode = "not_found";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

/** 在 Project 行写入之后、诊断写入之前调用，测试用它证明事务把两行一起回滚。 */
export type CreateProjectHooks = { afterProjectInsert?: (created: Project) => void };

type ProjectRow = typeof project.$inferSelect;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project 行与 `project.created` 诊断在同一个事务里写入，任一步失败整体回滚。 */
export function createProject(
  input: CreateProjectInput,
  ctx: ProjectContext,
  hooks: CreateProjectHooks = {},
  now: Date = new Date(),
): Project {
  return sqlite.transaction(() => {
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const created: Project = {
      id: newId(ID_PREFIXES.project),
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    db.insert(project)
      .values({
        id: created.id,
        name: created.name,
        description: created.description ?? null,
        createdBy: ctx.userId,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    hooks.afterProjectInsert?.(created);
    db.insert(diagnosticEvent)
      .values({
        id: newId(ID_PREFIXES.diagnostic),
        at: at,
        level: "info",
        event: "project.created",
        requestId: ctx.requestId,
        projectId: created.id,
        message: "Project 已创建",
        data: JSON.stringify({ name: created.name }),
      })
      .run();
    return created;
  })();
}

/** 改名与改描述在同一个事务里写入，同时留下 `project.updated` 诊断。 */
export function updateProject(
  id: string,
  input: UpdateProjectInput,
  ctx: ProjectContext,
  hooks: CreateProjectHooks = {},
  now: Date = new Date(),
): Project {
  return sqlite.transaction(() => {
    getProject(id, ctx);
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const row = db
      .update(project)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updatedAt: at,
      })
      .where(and(eq(project.id, id), eq(project.createdBy, ctx.userId)))
      .returning()
      .get();
    if (!row) throw new ProjectError("not_found", "Project 不存在");
    hooks.afterProjectInsert?.(toProject(row));
    db.insert(diagnosticEvent)
      .values({
        id: newId(ID_PREFIXES.diagnostic),
        at: at,
        level: "info",
        event: "project.updated",
        requestId: ctx.requestId,
        projectId: id,
        message: "Project 已更新",
        data: JSON.stringify({ fields: Object.keys(input) }),
      })
      .run();
    return toProject(row);
  })();
}

/** 调用者只能列出自己创建的 Project，最新创建的排在前面。 */
export function listProjects(ctx: ProjectContext): Project[] {
  return db
    .select()
    .from(project)
    .where(eq(project.createdBy, ctx.userId))
    .orderBy(desc(project.createdAt), desc(sql`rowid`))
    .all()
    .map(toProject);
}

/** 不存在的 id 与不属于调用者的 id 同样返回 not_found，不泄漏两者的区别。 */
export function getProject(id: string, ctx: ProjectContext): Project {
  const row = db
    .select()
    .from(project)
    .where(and(eq(project.id, id), eq(project.createdBy, ctx.userId)))
    .get();
  if (!row) throw new ProjectError("not_found", "Project 不存在");
  return toProject(row);
}
