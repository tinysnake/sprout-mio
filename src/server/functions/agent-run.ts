import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  abortAgentRunInput,
  chatRunActivitiesInput,
  chatRunStateInput,
  chatRunSelectionInput,
  type ChatRunSummary,
} from "../../contracts/agent-run";
import type {
  AgentRun,
  AgentRunResult,
  ChatRunActivity,
  ChatRunState,
} from "../../contracts/agent-run";
import { fail, ok, toAppError } from "../../contracts/result";
import { fieldErrorsFrom } from "../../contracts/project";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { readRunActivity, readRunReplyText } from "../pi-host/run-activity";
import { toDomainAppError } from "./domain-errors";

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, runs, runtime] = await Promise.all([
    import("../session"),
    import("../../domain/agent-run"),
    import("../runtime"),
  ]);
  return {
    requireSession: session.requireSession,
    piHostSnapshot: runtime.piHostSnapshot,
    ...runs,
  };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<AgentRunResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[agent-run] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "agent_run.request_failed",
    requestId,
    message: "Agent run 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function agentRunBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (
    deps: ServerDeps,
    context: ProjectContext,
  ) => AgentRunResult<T> | Promise<AgentRunResult<T>>,
): Promise<AgentRunResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): AgentRunResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

/** 对话页的 run 视角：宿主启用状态、活跃 run 与最近一个 run 的输入投递状态。 */
export async function getChatRunStateBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentRunResult<ChatRunState>> {
  return agentRunBoundary<ChatRunState>(headers, requestId, (deps, context) => {
    const parsed = chatRunStateInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const latest = deps.latestAgentRun(parsed.data.chatId, context);
    const { piHostSnapshot } = deps;
    return ok(
      {
        enabled: piHostSnapshot().enabled,
        active: deps
          .listActiveAgentRuns(parsed.data.chatId, context)
          .map(({ id, instanceId, status, attention }) => {
            const activity = readRunActivity(id);
            return {
              id,
              instanceId,
              status,
              ...(attention ? { attention } : {}),
              ...(activity ? { activity } : {}),
            };
          }),
        latest,
        inputs: latest ? deps.listAgentRunInputs(latest.id, context) : [],
      },
      requestId,
    );
  });
}

/**
 * 对话页的消息底部记录：已结束 run 的完整工作记录，按产出消息归属。
 * 不是状态轮询的一部分：run 收尾后 run 指纹变化会触发一次整树重读。
 */
export async function listChatRunActivitiesBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentRunResult<ChatRunActivity[]>> {
  return agentRunBoundary<ChatRunActivity[]>(headers, requestId, (deps, context) => {
    const parsed = chatRunActivitiesInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listChatRunActivities(parsed.data.chatId, context), requestId);
  });
}

/** 停止的真值在 run 状态机，投递给子进程的 abort 只是停止的传导。 */
export async function abortAgentRunBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentRunResult<AgentRun>> {
  return agentRunBoundary<AgentRun>(headers, requestId, async (deps, context) => {
    const parsed = abortAgentRunInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const run = deps.abortAgentRun(parsed.data.runId, context, readRunReplyText(parsed.data.runId));
    try {
      const { signalRunAbort } = await import("../runtime");
      signalRunAbort(run.id);
    } catch (error) {
      console.error("[agent-run] 停止信号传导失败", { requestId, runId: run.id, error });
    }
    return ok(run, requestId);
  });
}

export async function getChatRunBoundary(
  input: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentRunResult<ChatRunSummary>> {
  return agentRunBoundary<ChatRunSummary>(headers, requestId, (deps, context) => {
    const parsed = chatRunSelectionInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const { configSnapshot, ...run } = deps.getAgentRun(parsed.data.runId, context);
    if (run.chatId !== parsed.data.chatId) {
      return fail({ code: "not_found", message: "对象不存在", requestId });
    }
    return ok(
      {
        ...run,
        ...(configSnapshot?.sessionFile ? { sessionFile: configSnapshot.sessionFile } : {}),
      },
      requestId,
    );
  });
}

export const getChatRunFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getChatRunBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getChatRunStateFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getChatRunStateBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listChatRunActivitiesFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listChatRunActivitiesBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const abortAgentRunFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    abortAgentRunBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
