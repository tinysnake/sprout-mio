import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { conversationIdInput } from "../../contracts/conversation";
import type { ConversationInfoView, InfoHubResult, ProjectInfoHub } from "../../contracts/info-hub";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, infoHub, access, agent] = await Promise.all([
    import("../session"),
    import("../../domain/info-hub"),
    import("../../domain/access"),
    import("../../domain/agent"),
  ]);
  return {
    requireSession: session.requireSession,
    ProjectAccessError: access.ProjectAccessError,
    AgentError: agent.AgentError,
    ...infoHub,
  };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

function failure(
  error: unknown,
  requestId: string,
  deps: ServerDeps | undefined,
  recordDiagnostic: DiagnosticRecorder | undefined,
): InfoHubResult<never> {
  if (deps && (error instanceof deps.ProjectAccessError || error instanceof deps.AgentError))
    return fail({ code: error.code, message: error.message, requestId });
  console.error("[info_hub] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "info_hub.request_failed",
    requestId,
    message: "Info Hub 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function infoHubBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => InfoHubResult<T>,
): Promise<InfoHubResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): InfoHubResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function getProjectInfoHubBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<ProjectInfoHub>> {
  return infoHubBoundary<ProjectInfoHub>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getProjectInfoHub(parsed.data.projectId, context), requestId);
  });
}

export async function getConversationInfoBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<ConversationInfoView>> {
  return infoHubBoundary<ConversationInfoView>(headers, requestId, (deps, context) => {
    const parsed = conversationIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getConversationInfo(parsed.data.conversationId, context), requestId);
  });
}

export const getProjectInfoHubFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getProjectInfoHubBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getConversationInfoFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getConversationInfoBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
