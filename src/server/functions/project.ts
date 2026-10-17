import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createProjectInput, fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import type { Project, ProjectResult } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import type { ProjectContext } from "../../domain/project";
import { getRequestContext } from "../request-context";

/** 认证、数据库与诊断只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, domain] = await Promise.all([
    import("../session"),
    import("../../domain/project"),
  ]);
  return { requireSession: session.requireSession, ...domain };
}

async function sessionContext(
  headers: Headers,
  requestId: string,
): Promise<AppResult<ProjectContext>> {
  const { requireSession } = await serverDeps();
  const session = await requireSession(headers, requestId);
  if (!session.ok) return { ok: false, error: session.error, requestId };
  return ok({ userId: session.data.userId, requestId }, requestId);
}

async function failure(error: unknown, requestId: string): Promise<ProjectResult<never>> {
  const { ProjectError } = await serverDeps();
  if (error instanceof ProjectError)
    return fail({ code: error.code, message: error.message, requestId });
  return fail(toAppError(error, requestId));
}

/** 边界顺序固定为先会话、再 zod、最后事务，失败以载荷返回而不是 HTTP 状态码。 */
export async function createProjectBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  const context = await sessionContext(headers, requestId);
  if (!context.ok) return context;
  const parsed = createProjectInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ...fail(toAppError(parsed.error, requestId)),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }
  const { createProject } = await serverDeps();
  try {
    return ok(createProject(parsed.data, context.data), requestId);
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function listProjectsBoundary(
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project[]>> {
  const context = await sessionContext(headers, requestId);
  if (!context.ok) return context;
  const { listProjects } = await serverDeps();
  try {
    return ok(listProjects(context.data), requestId);
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function getProjectBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  const context = await sessionContext(headers, requestId);
  if (!context.ok) return context;
  const parsed = projectIdInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ...fail(toAppError(parsed.error, requestId)),
      fieldErrors: fieldErrorsFrom(parsed.error),
    };
  }
  const { getProject } = await serverDeps();
  try {
    return ok(getProject(parsed.data.projectId, context.data), requestId);
  } catch (error) {
    return failure(error, requestId);
  }
}

export const createProjectFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    createProjectBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listProjectsFn = createServerFn({ method: "GET" }).handler(async () =>
  listProjectsBoundary(getRequestHeaders(), getRequestContext().requestId),
);

export const getProjectFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getProjectBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
