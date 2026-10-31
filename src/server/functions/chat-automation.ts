import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "../../contracts/ids";
import { chatAutomationCommandSchema } from "../../contracts/chat-automation";
import { fail, ok, toAppError, type AppResult } from "../../contracts/result";
import type { ChatAutomationData } from "../../domain/chat-automation";
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
): Promise<AppResult<ChatAutomationData>> {
  try {
    const { requireSession } = await import("../session");
    const session = await requireSession(headers, requestId);
    if (!session.ok) return session;
    const domain = await import("../../domain/chat-automation");
    const ctx = { userId: session.data.userId, requestId };
    if (!mutate) {
      const parsed = readInput.parse(raw);
      return ok(domain.getChatAutomation(parsed.projectId, parsed.chatId, ctx), requestId);
    }
    const command = chatAutomationCommandSchema.parse(raw);
    const result = domain.applyChatAutomationCommand(command, ctx, new Date());
    const { signalRunAbort } = await import("../runtime");
    domain.drainAutomationAborts(new Date(), signalRunAbort);
    return ok(result, requestId);
  } catch (error) {
    return fail((await toDomainAppError(error, requestId)) ?? toAppError(error, requestId));
  }
}
export const getChatAutomationBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, false);
export const controlChatAutomationBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  boundary(raw, headers, requestId, true);
export const getChatAutomationFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) =>
    getChatAutomationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
export const controlChatAutomationFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) =>
    controlChatAutomationBoundary(data, getRequestHeaders(), getRequestContext().requestId),
  );
