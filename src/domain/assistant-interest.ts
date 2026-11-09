import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  assistantInterest,
  assistantRunCursor,
  assistantWatch,
  assistantWatchCursor,
  assistantEvent,
} from "../db/schema";

export function resolveWatchIntents(
  assistantChatId: string,
  targetProjectId: string,
  targetChatId: string,
  now: Date,
) {
  db.update(assistantEvent)
    .set({ decisionResolvedAt: now })
    .where(
      and(
        eq(assistantEvent.assistantChatId, assistantChatId),
        isNull(assistantEvent.decisionResolvedAt),
        sql`json_extract(${assistantEvent.fact}, '$.watchIntent') = 1`,
        sql`json_extract(${assistantEvent.fact}, '$.targetProjectId') = ${targetProjectId}`,
        sql`json_extract(${assistantEvent.fact}, '$.targetChatId') = ${targetChatId}`,
      ),
    )
    .run();
}

export function stopAssistantWatch(
  assistantChatId: string,
  targetProjectId: string,
  targetChatId: string,
  humanId: string,
  now: Date,
) {
  return sqlite
    .transaction(() => {
      db.update(assistantWatch)
        .set({ revokedAt: now })
        .where(
          and(
            eq(assistantWatch.assistantChatId, assistantChatId),
            eq(assistantWatch.targetProjectId, targetProjectId),
            eq(assistantWatch.targetChatId, targetChatId),
            eq(assistantWatch.consentedBy, humanId),
            isNull(assistantWatch.revokedAt),
          ),
        )
        .run();
      resolveWatchIntents(assistantChatId, targetProjectId, targetChatId, now);
      return {
        action: "stopped" as const,
        active: false as const,
        targetProjectId,
        chatId: targetChatId,
      };
    })
    .immediate();
}

export function initializeWatchCursor(watch: typeof assistantWatch.$inferSelect, now: Date) {
  const boundary = sqlite
    .prepare("SELECT coalesce(max(rowid), 0) AS n FROM message WHERE chat_id=?")
    .get(watch.targetChatId) as { n: number };
  db.insert(assistantWatchCursor)
    .values({
      watchId: watch.id,
      windowStartedAt: now,
      nextDueAt: new Date(now.getTime() + watch.intervalSeconds * 1000),
      messageRowid: boundary.n,
    })
    .onConflictDoNothing()
    .run();
}

export function assistantRunInterval(assistantChatId: string, runId: string): number {
  const watch = db
    .select({ intervalSeconds: assistantWatch.intervalSeconds })
    .from(assistantInterest)
    .innerJoin(assistantWatch, eq(assistantWatch.id, assistantInterest.originId))
    .where(
      and(
        eq(assistantInterest.assistantChatId, assistantChatId),
        eq(assistantInterest.runId, runId),
        eq(assistantInterest.originKind, "watch"),
        isNull(assistantWatch.revokedAt),
      ),
    )
    .get();
  return watch?.intervalSeconds ?? 300;
}

export function rescheduleWatch(watch: typeof assistantWatch.$inferSelect, now: Date) {
  initializeWatchCursor(watch, now);
  db.update(assistantWatchCursor)
    .set({ nextDueAt: new Date(now.getTime() + watch.intervalSeconds * 1000) })
    .where(eq(assistantWatchCursor.watchId, watch.id))
    .run();
  const runs = db
    .select({ runId: assistantInterest.runId })
    .from(assistantInterest)
    .where(
      and(
        eq(assistantInterest.assistantChatId, watch.assistantChatId),
        eq(assistantInterest.originKind, "watch"),
        eq(assistantInterest.originId, watch.id),
      ),
    )
    .all();
  if (!runs.length) return;
  db.update(assistantRunCursor)
    .set({ nextDueAt: new Date(now.getTime() + watch.intervalSeconds * 1000) })
    .where(
      and(
        eq(assistantRunCursor.assistantChatId, watch.assistantChatId),
        inArray(
          assistantRunCursor.runId,
          runs.map((r: { runId: string }) => r.runId),
        ),
        isNull(assistantRunCursor.terminalCapturedAt),
      ),
    )
    .run();
}

export function enrollAssistantInterest(
  assistantChatId: string,
  runId: string,
  originKind: "watch" | "proposal",
  originId: string,
  now: Date,
) {
  db.insert(assistantInterest)
    .values({ assistantChatId, runId, originKind, originId })
    .onConflictDoNothing()
    .run();
  const seconds = assistantRunInterval(assistantChatId, runId);
  db.insert(assistantRunCursor)
    .values({ assistantChatId, runId, nextDueAt: new Date(now.getTime() + seconds * 1000) })
    .onConflictDoNothing()
    .run();
}
export function enrollChatWatches(runId: string, chatId: string, instanceId: string, now: Date) {
  const profile = db
    .select({ purpose: agentProfile.purpose })
    .from(agentInstance)
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .where(eq(agentInstance.id, instanceId))
    .get();
  if (profile?.purpose !== "worker") return;
  const watches = db
    .select()
    .from(assistantWatch)
    .where(and(eq(assistantWatch.targetChatId, chatId), isNull(assistantWatch.revokedAt)))
    .all();
  for (const watch of watches)
    enrollAssistantInterest(watch.assistantChatId, runId, "watch", watch.id, now);
}
export function enrollExistingWatch(watch: typeof assistantWatch.$inferSelect, now: Date) {
  const runs = db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.chatId, watch.targetChatId), inArray(agentRun.status, ["queued", "running"])),
    )
    .all();
  for (const run of runs) enrollChatWatches(run.id, run.chatId, run.instanceId, now);
}
