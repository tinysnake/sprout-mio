import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  addProjectMemberInput,
  agentProfileIdSchema,
  createAgentProfileInput,
  fieldErrorsFrom,
  updateAgentProfileInput,
} from "../../contracts/agent";
import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
import { projectIdInput } from "../../contracts/project";
import { projectMemberRemovalBlockedErrorSchema } from "../../contracts/project-member-removal";
import type { ProjectMemberRemovalOutcome } from "../../contracts/project-member-removal";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

const agentProfileTarget = z.object({ agentProfileId: agentProfileIdSchema });
const agentProfileUpdateRequest = z.object({
  agentProfileId: agentProfileIdSchema,
  ...updateAgentProfileInput.shape,
});

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, agent] = await Promise.all([import("../session"), import("../../domain/agent")]);
  return { requireSession: session.requireSession, ...agent };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<AgentResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped?.code === "project_member_removal_blocked")
    return fail(projectMemberRemovalBlockedErrorSchema.parse(mapped));
  if (mapped) return fail(mapped);
  console.error("[agent] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "agent.request_failed",
    requestId,
    message: "Agent 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function agentBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => AgentResult<T>,
): Promise<AgentResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): AgentResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function createAgentProfileBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<AgentProfile>> {
  return agentBoundary<AgentProfile>(headers, requestId, (deps, context) => {
    const parsed = createAgentProfileInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.createAgentProfile(parsed.data, context), requestId);
  });
}

export async function listAgentProfilesBoundary(
  headers: Headers,
  requestId: string,
): Promise<AgentResult<AgentProfile[]>> {
  return agentBoundary<AgentProfile[]>(headers, requestId, (deps, context) =>
    ok(deps.listAgentProfiles(context), requestId),
  );
}

export async function getAgentProfileBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<AgentProfile>> {
  return agentBoundary<AgentProfile>(headers, requestId, (deps, context) => {
    const parsed = agentProfileTarget.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getAgentProfile(parsed.data.agentProfileId, context), requestId);
  });
}

export async function updateAgentProfileBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<AgentProfile>> {
  return agentBoundary<AgentProfile>(headers, requestId, (deps, context) => {
    const parsed = agentProfileUpdateRequest.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const { agentProfileId, ...input } = parsed.data;
    return ok(deps.updateAgentProfile(agentProfileId, input, context), requestId);
  });
}

export async function addProjectMemberBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<ProjectMember>> {
  return agentBoundary<ProjectMember>(headers, requestId, (deps, context) => {
    const parsed = addProjectMemberInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(
      deps.addProjectMember(parsed.data.projectId, parsed.data.agentProfileId, context),
      requestId,
    );
  });
}

export async function removeProjectMemberBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<null>> {
  return agentBoundary<null>(headers, requestId, (deps, context) => {
    const parsed = addProjectMemberInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    deps.removeProjectMember(parsed.data.projectId, parsed.data.agentProfileId, context);
    return ok(null, requestId);
  });
}

/**
 * 强制移除的接线层：只做鉴权、输入校验与 `MachineContext` 组装，
 * 全部业务步骤都在已冻结的 `forceRemoveProjectMember` 事务里，这里不自建事务、不加规则。
 */
export async function forceRemoveProjectMemberBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<ProjectMemberRemovalOutcome>> {
  let recordDiagnostic: DiagnosticRecorder | undefined;
  try {
    ({ recordDiagnostic } = await import("../diagnostics"));
    const [{ requireSession }, domain, { machineRuntimeContext }] = await Promise.all([
      import("../session"),
      import("../../domain/agent"),
      import("../runtime"),
    ]);
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const parsed = addProjectMemberInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    const runtime = await machineRuntimeContext();
    return ok(
      domain.forceRemoveProjectMember(parsed.data.projectId, parsed.data.agentProfileId, {
        userId: session.data.userId,
        requestId,
        ...runtime,
      }),
      requestId,
    );
  } catch (error) {
    return failure(error, requestId, recordDiagnostic);
  }
}

export async function listProjectMembersBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AgentResult<ProjectMember[]>> {
  return agentBoundary<ProjectMember[]>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listProjectMembers(parsed.data.projectId, context), requestId);
  });
}

export const createAgentProfileFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    createAgentProfileBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listAgentProfilesFn = createServerFn({ method: "GET" }).handler(async () =>
  listAgentProfilesBoundary(getRequestHeaders(), getRequestContext().requestId),
);

export const getAgentProfileFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getAgentProfileBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const updateAgentProfileFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    updateAgentProfileBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const addProjectMemberFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    addProjectMemberBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const removeProjectMemberFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    removeProjectMemberBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const forceRemoveProjectMemberFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    forceRemoveProjectMemberBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listProjectMembersFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listProjectMembersBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
