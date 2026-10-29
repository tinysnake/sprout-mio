import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  chatIdInput,
  clearChatTitleInput,
  createDirectChatInput,
  sendMessageInput,
  updateChatTitleInput,
} from "../../contracts/chat";
import type {
  AgentInstance,
  Chat,
  ChatMember,
  ChatResult,
  ChatDetail,
  Message,
} from "../../contracts/chat";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import type { DiagnosticInput } from "../diagnostics";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

const sendMessageRequest = z.object({
  ...chatIdInput.shape,
  body: sendMessageInput.shape.body,
});

/** 认证与领域模块只在服务端加载，客户端经 RPC 存根调用，不把 SQLite 带进浏览器。 */
async function serverDeps() {
  const [session, chat] = await Promise.all([import("../session"), import("../../domain/chat")]);
  return { requireSession: session.requireSession, ...chat };
}
type ServerDeps = Awaited<ReturnType<typeof serverDeps>>;
type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<ChatResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[chat] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "chat.request_failed",
    requestId,
    message: "Chat 请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

async function chatBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: ServerDeps, context: ProjectContext) => ChatResult<T>,
): Promise<ChatResult<T>> {
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

function invalidInput(error: z.ZodError, requestId: string): ChatResult<never> {
  return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
}

export async function createDirectChatBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<ChatDetail>> {
  return chatBoundary<ChatDetail>(headers, requestId, (deps, context) => {
    const parsed = createDirectChatInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(
      deps.createDirectChat(parsed.data.projectId, parsed.data.agentProfileId, context),
      requestId,
    );
  });
}

export async function listChatsBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Chat[]>> {
  return chatBoundary<Chat[]>(headers, requestId, (deps, context) => {
    const parsed = projectIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listChats(parsed.data.projectId, context), requestId);
  });
}

export async function getChatBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Chat>> {
  return chatBoundary<Chat>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.getChat(parsed.data.chatId, context), requestId);
  });
}

export async function listChatMembersBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<ChatMember[]>> {
  return chatBoundary<ChatMember[]>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listChatMembers(parsed.data.chatId, context), requestId);
  });
}

export async function listInstancesForChatBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<AgentInstance[]>> {
  return chatBoundary<AgentInstance[]>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listInstancesForChat(parsed.data.chatId, context), requestId);
  });
}

export async function listMessagesBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Message[]>> {
  return chatBoundary<Message[]>(headers, requestId, (deps, context) => {
    const parsed = chatIdInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.listMessages(parsed.data.chatId, context), requestId);
  });
}

/** 页面只发送 human 消息，sender 从认证会话构造，不接受浏览器传入的身份。 */ export async function sendMessageBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Message>> {
  return chatBoundary<Message>(headers, requestId, (deps, context) => {
    const parsed = sendMessageRequest.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(
      deps.sendMessage(
        parsed.data.chatId,
        { senderKind: "human", senderId: context.userId, body: parsed.data.body },
        context,
      ),
      requestId,
    );
  });
}

export const createDirectChatFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    createDirectChatBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

/** 重命名标题：归属、字段边界与写入都在服务端完成，UI 不自查权限。 */
export async function updateChatTitleBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Chat>> {
  return chatBoundary<Chat>(headers, requestId, (deps, context) => {
    const parsed = updateChatTitleInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.updateChatTitle(parsed.data.chatId, parsed.data.title, context), requestId);
  });
}

/** 恢复默认标题：把 title 置空，展示回到参与分身名。 */
export async function clearChatTitleBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<ChatResult<Chat>> {
  return chatBoundary<Chat>(headers, requestId, (deps, context) => {
    const parsed = clearChatTitleInput.safeParse(raw);
    if (!parsed.success) return invalidInput(parsed.error, requestId);
    return ok(deps.clearChatTitle(parsed.data.chatId, context), requestId);
  });
}

export const listChatsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listChatsBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const getChatFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    getChatBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listChatMembersFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listChatMembersBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const listInstancesForChatFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    listInstancesForChatBoundary(data, getRequestHeaders(), getRequestContext().requestId),
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

export const updateChatTitleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    updateChatTitleBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );

export const clearChatTitleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) =>
    clearChatTitleBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
