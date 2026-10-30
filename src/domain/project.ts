import { and, desc, eq, sql } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { CreateProjectInput, Project, UpdateProjectInput } from "../contracts/project";
import { db, sqlite } from "../db";
import { diagnosticEvent, project } from "../db/schema";
import { assertProjectAccess, ProjectAccessError, readRunScope } from "./access";
import { ensureProjectChannel } from "./channel";

/**
 * 一次 Agent run 的执行身份。它是从 run 行与它引用的 instance 读出的，不由调用方传入：
 * 人类消息开出的 run 同样以分身身份执行域代码，宿主也不需要从 `userId` 猜这段代码是谁在跑。
 */
export type RunAgentIdentity = {
  readonly agentProfileId: string;
  readonly instanceId: string;
  readonly runId: string;
};

/**
 * 调用者身份与请求关联在边界确定，业务服务不读取 HTTP 概念。
 * `userId` 只承担 Project 归属（agent_run 的 owner 语义不变）；`agent` 在 run 里执行时出现。
 */
export type ProjectContext = {
  readonly userId: string;
  readonly requestId: string;
  readonly agent?: RunAgentIdentity;
};

/** 业务服务只登记调用方可以据以行动的失败，其余错误由边界映射为 internal。 */
export type ProjectErrorCode = "not_found" | "forbidden";

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

/** Project 行、它的公共频道与 `project.created` 诊断在同一个事务里写入，任一步失败整体回滚。 */
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
    // 频道与 Project 一起出生（裁定 §4.1 的饥渴创建，不在读路径上补写）；同一事务保证
    // 不会出现「有 Project 却没有频道」的中间态。
    ensureProjectChannel(created.id);
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
    // 归属与范围先判（access.assertProjectAccess 是唯一判定点）：跨 Project 一律 not_found，
    // 再对同一个 Project 里的写入判禁止。Agent 执行身份只能读自己 Project，Project 事实只由 Human 改。
    getProject(id, ctx);
    if (ctx.agent) throw new ProjectError("forbidden", "Agent 执行身份不能修改 Project");
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
  // Agent 执行身份的范围只有它 run 所在的 Project：列表也走同一个判定点，
  // 而不是另写一份 `project.id === run.projectId` 的比较。
  if (ctx.agent) {
    const scope = readRunScope(ctx.agent.runId);
    if (!scope) throw new ProjectAccessError();
    return [assertProjectAccess(ctx, scope.projectId)];
  }
  return db
    .select()
    .from(project)
    .where(eq(project.createdBy, ctx.userId))
    .orderBy(desc(project.createdAt), desc(sql`rowid`))
    .all()
    .map(toProject);
}

/** 不存在的 id、不属于调用者的 id 与 Agent 跨 Project 的 id 同样返回 not_found，不泄漏三者的区别。 */
export function getProject(id: string, ctx: ProjectContext): Project {
  return assertProjectAccess(ctx, id);
}
