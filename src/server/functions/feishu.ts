import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  feishuBindingInput,
  feishuRevisionInput,
  feishuStartChallengeInput,
  type FeishuBindingView,
  type FeishuChallengeView,
  type FeishuTargetsView,
} from "../../contracts/feishu-channel";
import { fail, ok, toAppError } from "../../contracts/result";
import type { AppResult, AppErrorCode } from "../../contracts/result";
import type { ProjectContext } from "../../domain/project";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

/**
 * 绑定页的服务端边界：只有 Human 会话能调用，Human 身份永远来自会话，
 * 不接受调用方提交的 Human id，也不把网络 payload 变成 VerifiedFeishuIdentity。
 */

type BindingCode =
  | "forbidden"
  | "target_unavailable"
  | "identity_conflict"
  | "invalid_challenge"
  | "revision_conflict"
  | "not_bound";

type PlainAppCode = Exclude<AppErrorCode, "project_member_removal_blocked">;

const BINDING_MESSAGES: Readonly<Record<BindingCode, { code: PlainAppCode; message: string }>> = {
  forbidden: { code: "forbidden", message: "只有 Human 可以绑定 Feishu 私聊" },
  target_unavailable: { code: "conflict", message: "目标对话不可用" },
  identity_conflict: { code: "conflict", message: "这个 Feishu 身份已绑定到其他账号" },
  invalid_challenge: { code: "conflict", message: "确认码已失效，请重新发起绑定" },
  revision_conflict: { code: "conflict", message: "绑定状态已变化，请刷新后重试" },
  not_bound: { code: "conflict", message: "尚未绑定 Feishu 私聊" },
};

const BINDING_PREFIX = "Feishu binding: ";

/** 域层只暴露错误码；这里显式翻译，不用会把所有未知错误说成 conflict 的兜底。 */
function bindingCode(error: unknown): BindingCode | undefined {
  if (!(error instanceof Error) || !error.message.startsWith(BINDING_PREFIX)) return undefined;
  const code = error.message.slice(BINDING_PREFIX.length);
  return code in BINDING_MESSAGES ? (code as BindingCode) : undefined;
}

async function serverDeps() {
  const [authModule, domain, view, registry] = await Promise.all([
    import("../session"),
    import("../../domain/feishu"),
    import("../feishu/view"),
    import("../feishu/registry"),
  ]);
  return {
    requireSession: authModule.requireSession,
    domain,
    view,
    registry,
  };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;

function currentView(
  deps: ServerDeps,
  context: ProjectContext,
  projectId: string,
): FeishuBindingView {
  return deps.view.buildFeishuBindingView({
    ctx: context,
    projectId,
    connection: deps.registry.feishuConnectionSnapshot(projectId),
  });
}

async function failure(error: unknown, requestId: string): Promise<AppResult<never>> {
  const code = bindingCode(error);
  if (code) {
    const { code: appCode, message } = BINDING_MESSAGES[code];
    return fail({ code: appCode, message, requestId });
  }
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[feishu] 请求失败", { requestId, error });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function feishuBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => AppResult<T>,
): Promise<AppResult<T>> {
  try {
    const deps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    return operation(deps, { userId: session.data.userId, requestId });
  } catch (error) {
    return failure(error, requestId);
  }
}

export async function getFeishuBindingBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<FeishuBindingView>> {
  return feishuBoundary(headers, requestId, (deps, context) => {
    const parsed = feishuBindingInput.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    return ok(currentView(deps, context, parsed.data.projectId), requestId);
  });
}

export async function startFeishuChallengeBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<FeishuChallengeView>> {
  return feishuBoundary(headers, requestId, (deps, context) => {
    const parsed = feishuStartChallengeInput.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    const { projectId, chatId, expectedRevision } = parsed.data;
    const binding = deps.domain.getFeishuBinding(projectId, context);
    if (binding.revision !== expectedRevision)
      return fail({ ...BINDING_MESSAGES.revision_conflict, requestId });
    const started = deps.domain.startFeishuChallenge({ projectId, chatId }, context);
    return ok(
      {
        challenge: started.challenge,
        expiresAtMs: started.expiresAtMs,
        revision: started.revision,
        binding: currentView(deps, context, projectId),
      },
      requestId,
    );
  });
}

/**
 * 绑定完成的唯一权威来源是适配器：VerifiedFeishuIdentity 只在 WS 入站路径产生。
 * 这里不接受任何身份字段，只确认「适配器已写入的绑定」并与页面 revision 对齐；
 * 未绑定或 revision 过期都 fail closed，让页面重新读取状态。
 */
export async function finishFeishuBindingBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<FeishuBindingView>> {
  return feishuBoundary(headers, requestId, (deps, context) => {
    const parsed = feishuRevisionInput.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    const binding = deps.domain.getFeishuBinding(parsed.data.projectId, context);
    if (binding.revision !== parsed.data.expectedRevision)
      return fail({ ...BINDING_MESSAGES.revision_conflict, requestId });
    if (!binding.bound)
      return fail({
        code: "conflict",
        message: "尚未在 Feishu 完成确认，请先在私聊里发送确认码",
        requestId,
      });
    return ok(currentView(deps, context, parsed.data.projectId), requestId);
  });
}

export async function unbindFeishuBindingBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<FeishuBindingView>> {
  return feishuBoundary(headers, requestId, (deps, context) => {
    const parsed = feishuRevisionInput.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    deps.domain.unbindFeishuIdentity(parsed.data.projectId, parsed.data.expectedRevision, context);
    deps.registry.wakeFeishuDelivery();
    return ok(currentView(deps, context, parsed.data.projectId), requestId);
  });
}

export async function listFeishuTargetsBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<AppResult<FeishuTargetsView>> {
  return feishuBoundary(headers, requestId, (deps, context) => {
    const parsed = feishuBindingInput.safeParse(raw);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    return ok(
      deps.view.buildFeishuTargetsView({ ctx: context, projectId: parsed.data.projectId }),
      requestId,
    );
  });
}

export const getFeishuBindingFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getFeishuBindingBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const startFeishuChallengeFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    startFeishuChallengeBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const finishFeishuBindingFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    finishFeishuBindingBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const unbindFeishuBindingFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    unbindFeishuBindingBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listFeishuTargetsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listFeishuTargetsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
