import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  assistantInterest,
  assistantPreferences,
  assistantRunCursor,
  assistantWatch,
} from "../db/schema";

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
  const seconds =
    db
      .select()
      .from(assistantPreferences)
      .where(eq(assistantPreferences.assistantChatId, assistantChatId))
      .get()?.intervalSeconds ?? 300;
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
