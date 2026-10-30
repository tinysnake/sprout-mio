import { and, eq } from "drizzle-orm";
import type { Project } from "../contracts/project";
import { db } from "../db";
import { agentInstance, agentRun, project } from "../db/schema";
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

/**
 * Agent 执行身份的范围事实。`userId` 只表示 Project 归属（人类消息开出的 run 也以分身身份执行），
 * 「这次运行在哪」只能从 run 行本身读：它属于哪个 Project、哪个对话、哪个 instance。
 */
export type RunScope = {
  readonly projectId: string;
  readonly chatId: string;
  readonly instanceId: string;
  readonly agentProfileId: string;
  /** `queued` 与 `running` 是活跃执行；结束后的 run 只剩历史，不能再读写对话。 */
  readonly active: boolean;
};

/**
 * 读一条 run 的执行范围。run、它引用的 instance 与 Project 必须三者自洽：复合连接不成立
 * 就当作没有这条身份，而不是退回调用方传进来的字段——那等于让调用方自己声明范围。
 */
export function readRunScope(runId: string): RunScope | undefined {
  const row = db
    .select({
      projectId: agentRun.projectId,
      chatId: agentRun.chatId,
      instanceId: agentRun.instanceId,
      agentProfileId: agentInstance.agentProfileId,
      status: agentRun.status,
    })
    .from(agentRun)
    .innerJoin(
      agentInstance,
      and(
        eq(agentInstance.id, agentRun.instanceId),
        eq(agentInstance.chatId, agentRun.chatId),
        eq(agentInstance.projectId, agentRun.projectId),
      ),
    )
    .where(eq(agentRun.id, runId))
    .get();
  if (!row) return undefined;
  return {
    projectId: row.projectId,
    chatId: row.chatId,
    instanceId: row.instanceId,
    agentProfileId: row.agentProfileId,
    active: row.status === "queued" || row.status === "running",
  };
}

/**
 * Human 的范围是 `project.created_by`；Agent 执行身份还要落在它自己 run 的 Project 里。
 * 只比创建者会让同一 Human 名下 A 的 run 读到 B 的一切（验收 A04 的根因就在这一行）。
 */
export function assertProjectAccess(ctx: ProjectContext, projectId: string): Project {
  const row = db
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.createdBy, ctx.userId)))
    .get();
  if (!row) throw new ProjectAccessError();
  if (ctx.agent && readRunScope(ctx.agent.runId)?.projectId !== projectId)
    throw new ProjectAccessError();
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
