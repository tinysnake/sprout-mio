import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { prepareProjectRepoInput } from "../../contracts/repository";
import type { ProjectRepoState, RepoCheckout, RepositoryResult } from "../../contracts/repository";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, repository] = await Promise.all([
    import("../session"),
    import("../../domain/repository"),
  ]);
  return { requireSession: session.requireSession, ...repository };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<RepositoryResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[repository] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "repository.request_failed",
    requestId,
    message: "仓库入口请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function repositoryBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => Promise<RepositoryResult<T>>,
): Promise<RepositoryResult<T>> {
  let deps: ServerDeps | undefined;
  let recordDiagnostic: DiagnosticRecorder | undefined;
  try {
    ({ recordDiagnostic } = await import("../diagnostics"));
    deps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    return await operation(deps, { userId: session.data.userId, requestId });
  } catch (error) {
    return failure(error, requestId, recordDiagnostic);
  }
}

function invalidInput(error: z.ZodError, requestId: string): RepositoryResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function getProjectRepoStateBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<RepositoryResult<ProjectRepoState>> {
  return repositoryBoundary<ProjectRepoState>(headers, requestId, async (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getProjectRepoState(parsed.data.projectId, context), requestId);
  });
}

export async function prepareProjectRepoBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<RepositoryResult<RepoCheckout>> {
  return repositoryBoundary<RepoCheckout>(headers, requestId, async (deps, context) => {
    const parsed = prepareProjectRepoInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const checkout = await deps.prepareProjectRepo(parsed.data.projectId, context);
    return ok(checkout, requestId);
  });
}

export const getProjectRepoStateFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getProjectRepoStateBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const prepareProjectRepoFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    prepareProjectRepoBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
