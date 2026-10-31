import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  createProjectInput,
  fieldErrorsFrom,
  projectIdInput,
  updateProjectInput,
  updateProjectWakePolicyInputSchema,
} from "../../contracts/project";
import type { Project, ProjectResult } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/project";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

/** 认证与数据库只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, domain] = await Promise.all([
    import("../session"),
    import("../../domain/project"),
  ]);
  return { requireSession: session.requireSession, ...domain };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<ProjectResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[project] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "project.request_failed",
    requestId,
    message: "Project 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function projectBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => ProjectResult<T>,
): Promise<ProjectResult<T>> {
  let deps: ServerDeps | undefined;
  let recordDiagnostic: DiagnosticRecorder | undefined;
  try {
    ({ recordDiagnostic } = await import("../diagnostics"));
    deps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    return operation(deps, { userId: session.data.userId, requestId });
  } catch (error) {
    return failure(error, requestId, recordDiagnostic);
  }
}

/** 边界顺序固定为先会话、再 zod、最后事务，失败以载荷返回而不是 HTTP 状态码。 */
export async function createProjectBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  return projectBoundary<Project>(headers, requestId, (deps, context) => {
    const parsed = createProjectInput.safeParse(raw);
    if (!parsed.success) {
      return {
        ...fail(toAppError(parsed.error, requestId)),
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }
    return ok(deps.createProject(parsed.data, context), requestId);
  });
}

export async function listProjectsBoundary(
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project[]>> {
  return projectBoundary<Project[]>(headers, requestId, (deps, context) =>
    ok(deps.listProjects(context), requestId),
  );
}

export async function getProjectBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  return projectBoundary<Project>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) {
      return {
        ...fail(toAppError(parsed.error, requestId)),
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }
    return ok(deps.getProject(parsed.data.projectId, context), requestId);
  });
}

export async function updateProjectBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  return projectBoundary<Project>(headers, requestId, (deps, context) => {
    const { projectId, ...rest } = (raw ?? {}) as { projectId?: unknown };
    const id = projectIdInput.safeParse({ projectId });
    if (!id.success) {
      return {
        ...fail(toAppError(id.error, requestId)),
        fieldErrors: fieldErrorsFrom(id.error),
      };
    }
    const parsed = updateProjectInput.safeParse(rest);
    if (!parsed.success) {
      return {
        ...fail(toAppError(parsed.error, requestId)),
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }
    return ok(deps.updateProject(id.data.projectId, parsed.data, context), requestId);
  });
}

export async function updateProjectWakePolicyBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<Project>> {
  return projectBoundary<Project>(headers, requestId, (deps, context) => {
    const parsed = updateProjectWakePolicyInputSchema.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    const model =
      parsed.data.provider === "jev"
        ? process.env.SPROUT_WAKE_JEV_MODEL
        : process.env.SPROUT_WAKE_SMALL_BRAIN_MODEL;
    const thresholdVersion = process.env.SPROUT_WAKE_THRESHOLD_VERSION;
    if (!model || !thresholdVersion)
      return fail({
        code: "wake_provider_unavailable",
        message: "所选判定器尚未配置模型与阈值版本。",
        requestId,
      });
    return ok(
      deps.updateProjectWakePolicy(parsed.data, context, { model, thresholdVersion }, new Date()),
      requestId,
    );
  });
}

export const updateProjectWakePolicyFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) =>
    updateProjectWakePolicyBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

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

export const updateProjectFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    updateProjectBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
