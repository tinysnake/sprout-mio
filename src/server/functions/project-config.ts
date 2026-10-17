import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import type { ProjectResult } from "../../contracts/project";
import { updateProjectProfileInput } from "../../contracts/project-config";
import type { ProjectProfile } from "../../contracts/project-config";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";

const projectProfileUpdateRequest = z.object({
  projectId: projectIdInput.shape.projectId,
  ...updateProjectProfileInput.shape,
});

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, config, access] = await Promise.all([
    import("../session"),
    import("../../domain/project-config"),
    import("../../domain/access"),
  ]);
  return {
    requireSession: session.requireSession,
    ProjectAccessError: access.ProjectAccessError,
    ...config,
  };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

function failure(
  error: unknown,
  requestId: string,
  deps: ServerDeps | undefined,
  recordDiagnostic: DiagnosticRecorder | undefined,
): ProjectResult<never> {
  if (deps && error instanceof deps.ProjectAccessError)
    return fail({ code: error.code, message: error.message, requestId });
  console.error("[project-config] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "project_config.request_failed",
    requestId,
    message: "Project 配置请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function projectConfigBoundary<T>(
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
    return failure(error, requestId, deps, recordDiagnostic);
  }
}

function invalidInput(error: z.ZodError, requestId: string): ProjectResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function getProjectProfileBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<ProjectProfile>> {
  return projectConfigBoundary<ProjectProfile>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getProjectProfile(parsed.data.projectId, context), requestId);
  });
}

export async function updateProjectProfileBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ProjectResult<ProjectProfile>> {
  return projectConfigBoundary<ProjectProfile>(headers, requestId, (deps, context) => {
    const parsed = projectProfileUpdateRequest.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const { projectId, ...input } = parsed.data;
    return ok(deps.updateProjectProfile(projectId, input, context), requestId);
  });
}

export const getProjectProfileFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getProjectProfileBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const updateProjectProfileFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    updateProjectProfileBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
