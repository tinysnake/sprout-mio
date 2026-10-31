import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { chatIdInput } from "../../contracts/chat";
import type { ChatInfoView, InfoHubResult, ProjectInfoHub } from "../../contracts/info-hub";
import {
  infoHubGetInputSchema,
  infoHubRefreshInputSchema,
  agentInfoHubInputSchema,
  type AgentInfoView,
  type InfoHubView,
  type InfoHubRefreshResult,
} from "../../contracts/info-hub-query";
import {
  turnContextReadInputSchema,
  type TurnContextReadResult,
} from "../../contracts/turn-context";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, infoHub, turnContext] = await Promise.all([
    import("../session"),
    import("../../domain/info-hub"),
    import("../../domain/turn-context"),
  ]);
  return { requireSession: session.requireSession, ...infoHub, ...turnContext };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<InfoHubResult<never>> {
  if (error instanceof z.ZodError) return invalidInput(error, requestId);
  const { InfoHubError } = await import("../../domain/info-hub");
  if (error instanceof InfoHubError)
    return fail({ code: error.code, message: error.message, requestId });
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
  operation: (
    deps: ServerDeps,
    context: ProjectContext,
  ) => InfoHubResult<T> | Promise<InfoHubResult<T>>,
): Promise<InfoHubResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): InfoHubResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function getProjectInfoHubBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<ProjectInfoHub>> {
  return infoHubBoundary<ProjectInfoHub>(headers, requestId, async (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const { machineRuntimeContext } = await import("../runtime");
    const runtime = await machineRuntimeContext();
    return ok(deps.getProjectInfoHub(parsed.data.projectId, { ...context, ...runtime }), requestId);
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

export function readTurnContextBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<TurnContextReadResult>> {
  return infoHubBoundary<TurnContextReadResult>(headers, requestId, (deps, context) =>
    ok(deps.readTurnContext(turnContextReadInputSchema.parse(raw), context), requestId),
  );
}
export function getAgentInfoHubBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<AgentInfoView>> {
  return infoHubBoundary<AgentInfoView>(headers, requestId, (deps, context) => {
    const parsed = agentInfoHubInputSchema.parse(raw);
    return ok(deps.getAgentInfo(parsed.projectId, parsed.agentProfileId, context), requestId);
  });
}
export function getInfoHubBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<InfoHubView>> {
  return infoHubBoundary<InfoHubView>(headers, requestId, async (deps, context) => {
    const { projectId, ...query } = infoHubGetInputSchema.parse(raw);
    const { machineRuntimeContext } = await import("../runtime");
    return ok(
      deps.getInfoHub(projectId, query, { ...context, ...(await machineRuntimeContext()) }),
      requestId,
    );
  });
}
export function refreshInfoHubBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<InfoHubResult<InfoHubRefreshResult>> {
  return infoHubBoundary<InfoHubRefreshResult>(headers, requestId, async (deps, context) => {
    const { projectId, query, knownRevision } = infoHubRefreshInputSchema.parse(raw);
    const { machineRuntimeContext } = await import("../runtime");
    return ok(
      deps.refreshInfoHub(projectId, query, knownRevision, {
        ...context,
        ...(await machineRuntimeContext()),
      }),
      requestId,
    );
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

export const getInfoHubFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getInfoHubBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

/** Agent 视角的生产入口：status、活动/历史 run 与完整分身清单一次读回。 */
export const getAgentInfoHubFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getAgentInfoHubBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const refreshInfoHubFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    refreshInfoHubBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const readTurnContextFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    readTurnContextBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
