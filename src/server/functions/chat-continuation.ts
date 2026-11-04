import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "../../contracts/ids";
import { chatContinuationCommandSchema } from "../../contracts/chat-continuation";
import { fail, ok, toAppError, type AppResult } from "../../contracts/result";
import type { ChatContinuationData } from "../../domain/chat-continuation";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";
const readInput = z.strictObject({
  projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
  chatId: z.string().regex(appIdPattern(ID_PREFIXES.chat)),
});
async function boundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
  mutate: boolean,
): Promise<AppResult<ChatContinuationData>> {
  try {
    const { requireSession } = await import("../session");
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const domain = await import("../../domain/chat-continuation");
    const ctx = { userId: session.data.userId, requestId };
    if (!mutate) {
      const parsed = readInput.parse(raw);
      return ok(domain.getChatContinuation(parsed.projectId, parsed.chatId, ctx), requestId);
    }
    const command = chatContinuationCommandSchema.parse(raw);
    const result = domain.applyChatContinuationCommand(command, ctx, new Date());
    const { signalRunAbort } = await import("../runtime");
    domain.drainContinuationAborts(new Date(), signalRunAbort);
    return ok(result, requestId);
  } catch (error) {
    return fail((await toDomainAppError(error, requestId)) ?? toAppError(error, requestId));
  }
}
export const getChatContinuationBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, false);
export const controlChatContinuationBoundary = (
  raw: unknown,
  headers: Headers,
  requestId: string,
) => boundary(raw, headers, requestId, true);
export const getChatContinuationFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) =>
    getChatContinuationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const controlChatContinuationFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) =>
    controlChatContinuationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
