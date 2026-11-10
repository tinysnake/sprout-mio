import { and, eq, desc, inArray } from "drizzle-orm";
import { db } from "../db";
import { assistantEvent, assistantProposal, assistantWatch, message } from "../db/schema";
import { assistantWatchSummaryText } from "./assistant-watch-summary";
import { ProjectAccessError, type ProjectContext } from "./access";
import { getChat, ChatError } from "./chat";

export function readAssistantNativeFacts(chatId: string, ctx: ProjectContext) {
  return db
    .select()
    .from(message)
    .where(
      and(
        eq(message.chatId, chatId),
        inArray(message.senderKind, ["assistant_event", "assistant_work"]),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(50)
    .all()
    .reverse()
    .filter((row: typeof message.$inferSelect) => {
      const event = row.assistantEventId
        ? db.select().from(assistantEvent).where(eq(assistantEvent.id, row.assistantEventId)).get()
        : undefined;
      if (event?.suppressedAt) return false;
      if (event?.fact.watchId) {
        const watch = db
          .select()
          .from(assistantWatch)
          .where(eq(assistantWatch.id, event.fact.watchId))
          .get();
        if (
          !watch ||
          watch.revokedAt ||
          watch.consentedBy !== ctx.userId ||
          watch.assistantChatId !== chatId
        )
          return false;
      }
      const targetChatId = row.assistantEventId
        ? event?.fact.targetChatId
        : row.assistantProposalId
          ? db
              .select()
              .from(assistantProposal)
              .where(eq(assistantProposal.id, row.assistantProposalId))
              .get()?.targetChatId
          : undefined;
      if (!targetChatId) return false;
      try {
        return !getChat(targetChatId, ctx).archivedAt;
      } catch (error) {
        if (error instanceof ChatError || error instanceof ProjectAccessError) return false;
        throw error;
      }
    })
    .map((row: typeof message.$inferSelect) => {
      const fact = row.assistantEventId
        ? db.select().from(assistantEvent).where(eq(assistantEvent.id, row.assistantEventId)).get()
            ?.fact
        : undefined;
      return {
        messageId: row.id,
        kind: row.senderKind as "assistant_event" | "assistant_work",
        sourceId: row.senderId,
        body: fact?.digest
          ? assistantWatchSummaryText(row.assistantEventId!)
          : row.body.slice(0, 1000),
        createdAt: row.createdAt.toISOString(),
      };
    });
}
