import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { chatIdInput } from "../../contracts/chat";
import type {
  ChatInfoView,
  InfoHubResult,
  ProjectInfoHub,
  TurnStartContext,
} from "../../contracts/info-hub";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, infoHub] = await Promise.all([
    import("../session"),
    import("../../domain/info-hub"),
  ]);
  return { requireSession: session.requireSession, ...infoHub };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<InfoHubResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
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
    return failure(error, requestId, recordDiagnostic);
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

export async function getChatInfoBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<ChatInfoView>> {
  return infoHubBoundary<ChatInfoView>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getChatInfo(parsed.data.chatId, context), requestId);
  });
}

export async function getTurnStartContextBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<TurnStartContext>> {
  return infoHubBoundary<TurnStartContext>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getTurnStartContext(parsed.data.chatId, context), requestId);
  });
}

export const getProjectInfoHubFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getProjectInfoHubBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getChatInfoFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getChatInfoBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getTurnStartContextFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getTurnStartContextBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
