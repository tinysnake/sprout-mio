import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import { getRequestContext } from "../request-context";
const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("panel"), chatId: z.string() }),
  z.strictObject({
    action: z.enum(["confirm", "revoke"]),
    chatId: z.string(),
    proposalId: z.string(),
  }),
  z.strictObject({
    action: z.literal("watch"),
    chatId: z.string(),
    targetProjectId: z.string(),
    targetChatId: z.string(),
    active: z.boolean(),
    eventId: z.string().optional(),
    intervalSeconds: z.number().int().min(60).max(86400).optional(),
  }),
  z.strictObject({
    action: z.literal("interval"),
    chatId: z.string(),
    intervalSeconds: z.number().int().min(60).max(86400),
  }),
]);
export const assistantActionFn = createServerFn({ method: "POST" })
  .validator((x: unknown) => action.parse(x))
  .handler(async ({ data }) => {
    const requestId = getRequestContext().requestId;
    try {
      const { requireSession } = await import("../session");
      const session = await requireSession(getRequestHeaders(), requestId);
      if (!session.ok) return session;
      const ctx: ProjectContext = { userId: session.data.userId, requestId };
      const domain = await import("../../domain/assistant");
      const observer = await import("../../domain/assistant-observer");
      switch (data.action) {
        case "panel":
          return ok(domain.assistantPanel(data.chatId, ctx), requestId);
        case "confirm":
          return ok(domain.confirmAssistantProposal(data.proposalId, data.chatId, ctx), requestId);
        case "revoke":
          return ok(domain.revokeAssistantProposal(data.proposalId, data.chatId, ctx), requestId);
        case "watch":
          return ok(
            observer.setAssistantWatch(
              data.chatId,
              data.targetProjectId,
              data.targetChatId,
              data.active,
              ctx,
              new Date(),
              data.intervalSeconds,
              data.eventId,
            ),
            requestId,
          );
        case "interval":
          return ok(
            observer.setAssistantInterval(data.chatId, data.intervalSeconds, ctx),
            requestId,
          );
      }
    } catch (error) {
      return fail(toAppError(error, requestId));
    }
  });
