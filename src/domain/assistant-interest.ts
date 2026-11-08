import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  assistantInterest,
  assistantRunCursor,
  assistantWatch,
} from "../db/schema";

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
