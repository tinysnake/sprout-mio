import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { abortAgentRunInput, conversationRunStateInput } from "../../contracts/agent-run";
import type { AgentRun, AgentRunResult, ConversationRunState } from "../../contracts/agent-run";
import { fail, ok, toAppError } from "../../contracts/result";
import { fieldErrorsFrom } from "../../contracts/project";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
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

/** 对话页的 run 视角：宿主启用状态、已有 run 与最近一个 run 的输入投递状态。 */
export async function getConversationRunStateBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentRunResult<ConversationRunState>> {
  return agentRunBoundary<ConversationRunState>(headers, requestId, (deps, context) => {
    const parsed = conversationRunStateInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const runs = deps.listAgentRuns(parsed.data.conversationId, context);
    const latest = runs.at(-1);
    const { piHostSnapshot } = deps;
    return ok(
      {
        enabled: piHostSnapshot().enabled,
        runs,
        inputs: latest ? deps.listAgentRunInputs(latest.id, context) : [],
      },
      requestId,
    );
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
    const run = deps.abortAgentRun(parsed.data.runId, context);
    try {
      const { signalRunAbort } = await import("../runtime");
      signalRunAbort(run.id);
    } catch (error) {
      console.error("[agent-run] 停止信号传导失败", { requestId, runId: run.id, error });
    }
    return ok(run, requestId);
  });
}

export const getConversationRunStateFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getConversationRunStateBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const abortAgentRunFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    abortAgentRunBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
