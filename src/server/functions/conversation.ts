import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  conversationIdInput,
  createDirectConversationInput,
  sendMessageInput,
} from "../../contracts/conversation";
import type {
  AgentInstance,
  Conversation,
  ConversationMember,
  ConversationResult,
  DirectConversation,
  Message,
} from "../../contracts/conversation";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

const sendMessageRequest = z.object({
  ...conversationIdInput.shape,
  body: sendMessageInput.shape.body,
});

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, conversation] = await Promise.all([
    import("../session"),
    import("../../domain/conversation"),
  ]);
  return { requireSession: session.requireSession, ...conversation };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<ConversationResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[conversation] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "conversation.request_failed",
    requestId,
    message: "Conversation 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function conversationBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => ConversationResult<T>,
): Promise<ConversationResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): ConversationResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function createDirectConversationBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<DirectConversation>> {
  return conversationBoundary<DirectConversation>(headers, requestId, (deps, context) => {
    const parsed = createDirectConversationInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(
      deps.createDirectConversation(parsed.data.projectId, parsed.data.agentProfileId, context),
      requestId,
    );
  });
}

export async function listConversationsBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<Conversation[]>> {
  return conversationBoundary<Conversation[]>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listConversations(parsed.data.projectId, context), requestId);
  });
}

export async function getConversationBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<Conversation>> {
  return conversationBoundary<Conversation>(headers, requestId, (deps, context) => {
    const parsed = conversationIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getConversation(parsed.data.conversationId, context), requestId);
  });
}

export async function listConversationMembersBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<ConversationMember[]>> {
  return conversationBoundary<ConversationMember[]>(headers, requestId, (deps, context) => {
    const parsed = conversationIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listConversationMembers(parsed.data.conversationId, context), requestId);
  });
}

export async function listInstancesForConversationBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<AgentInstance[]>> {
  return conversationBoundary<AgentInstance[]>(headers, requestId, (deps, context) => {
    const parsed = conversationIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listInstancesForConversation(parsed.data.conversationId, context), requestId);
  });
}

export async function listMessagesBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<Message[]>> {
  return conversationBoundary<Message[]>(headers, requestId, (deps, context) => {
    const parsed = conversationIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listMessages(parsed.data.conversationId, context), requestId);
  });
}

/** 页面只发送 human 消息，sender 从认证会话构造，不接受浏览器传入的身份。 */
export async function sendMessageBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ConversationResult<Message>> {
  return conversationBoundary<Message>(headers, requestId, (deps, context) => {
    const parsed = sendMessageRequest.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(
      deps.sendMessage(
        parsed.data.conversationId,
        { senderKind: "human", senderId: context.userId, body: parsed.data.body },
        context,
      ),
      requestId,
    );
  });
}

export const createDirectConversationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    createDirectConversationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listConversationsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listConversationsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getConversationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getConversationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listConversationMembersFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listConversationMembersBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listInstancesForConversationFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listInstancesForConversationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listMessagesFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listMessagesBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const sendMessageFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    sendMessageBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
