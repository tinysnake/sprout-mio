import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, sqlite } from "../db";
import { assistantEvent, assistantWatch, assistantWatchSummary } from "../db/schema";
import { assistantSource, AssistantError } from "./assistant";
import { getChat, ChatError } from "./chat";
import { ProjectAccessError } from "./access";

export const SUMMARY_MAX_ATTEMPTS = 3;
export const SUMMARY_LEASE_MS = 120_000;
export const SUMMARY_FAILURE =
  "关注摘要生成失败；未将原始活动冒充摘要。请展开原始记录或查看来源对话。";
export const SUMMARY_LEGACY = "旧版关注记录，尚无语义摘要；可展开原始记录或查看来源对话。";

export function watchSummaryAccess(event: typeof assistantEvent.$inferSelect) {
  const watch =
    event.fact.watchId &&
    db
      .select()
      .from(assistantWatch)
      .where(
        and(
          eq(assistantWatch.id, event.fact.watchId),
          eq(assistantWatch.assistantChatId, event.assistantChatId),
          eq(assistantWatch.targetChatId, event.fact.targetChatId),
          eq(assistantWatch.targetProjectId, event.fact.targetProjectId),
          isNull(assistantWatch.revokedAt),
        ),
      )
      .get();
  if (!watch) throw new AssistantError("forbidden");
  const ctx = { userId: watch.consentedBy, requestId: "assistant-watch-summary" };
  const source = assistantSource(event.assistantChatId, ctx);
  const target = getChat(watch.targetChatId, ctx);
  if (target.archivedAt || target.projectId !== watch.targetProjectId)
    throw new AssistantError("forbidden");
  return source.profile;
}
function suppress(eventId: string, now: Date) {
  db.update(assistantEvent).set({ suppressedAt: now }).where(eq(assistantEvent.id, eventId)).run();
  db.update(assistantWatchSummary)
    .set({ status: "suppressed", leaseToken: null, leaseExpiresAt: null })
    .where(eq(assistantWatchSummary.eventId, eventId))
    .run();
}
function permitted(event: typeof assistantEvent.$inferSelect, now: Date) {
  try {
    return watchSummaryAccess(event);
  } catch (error) {
    if (
      !(
        error instanceof AssistantError ||
        error instanceof ChatError ||
        error instanceof ProjectAccessError
      )
    )
      throw error;
    suppress(event.id, now);
    return null;
  }
}
export function claimAssistantWatchSummaries(now: Date, limit = 2) {
  return sqlite
    .transaction(() => {
      const { active } = sqlite
        .prepare(
          "SELECT count(*) active FROM assistant_watch_summary WHERE status='running' AND lease_expires_at>?",
        )
        .get(now.getTime()) as { active: number };
      const capacity = Math.min(Math.max(0, 2 - active), Math.max(0, limit));
      if (!capacity) return [];
      const candidates = sqlite
        .prepare(`SELECT event_id FROM assistant_watch_summary
      WHERE (status='pending' AND next_attempt_at<=?) OR (status='running' AND lease_expires_at<=?)
      ORDER BY next_attempt_at,event_id LIMIT ?`)
        .all(now.getTime(), now.getTime(), capacity) as { event_id: string }[];
      const claims = [];
      for (const row of candidates) {
        const event = db
          .select()
          .from(assistantEvent)
          .where(eq(assistantEvent.id, row.event_id))
          .get()!;
        const job = db
          .select()
          .from(assistantWatchSummary)
          .where(eq(assistantWatchSummary.eventId, row.event_id))
          .get()!;
        if (event.suppressedAt || event.messageId) {
          suppress(event.id, now);
          continue;
        }
        const profile = permitted(event, now);
        if (!profile) continue;
        if (job.attempts >= SUMMARY_MAX_ATTEMPTS) {
          db.update(assistantWatchSummary)
            .set({
              status: "failed",
              error: "summary_lease_expired",
              leaseToken: null,
              leaseExpiresAt: null,
            })
            .where(eq(assistantWatchSummary.eventId, event.id))
            .run();
          continue;
        }
        const token = randomUUID();
        db.update(assistantWatchSummary)
          .set({
            status: "running",
            attempts: job.attempts + 1,
            leaseToken: token,
            leaseExpiresAt: new Date(now.getTime() + SUMMARY_LEASE_MS),
            model: profile.model,
            effort: profile.effort,
          })
          .where(eq(assistantWatchSummary.eventId, event.id))
          .run();
        claims.push({ event, token, profile: { model: profile.model, effort: profile.effort } });
      }
      return claims;
    })
    .immediate();
}
export type WatchSummaryClaim = ReturnType<typeof claimAssistantWatchSummaries>[number];
export function finishAssistantWatchSummary(
  claim: WatchSummaryClaim,
  result: { summary: string; model: string; effort: string } | { error: string },
  now = new Date(),
) {
  return sqlite
    .transaction(() => {
      const job = db
        .select()
        .from(assistantWatchSummary)
        .where(eq(assistantWatchSummary.eventId, claim.event.id))
        .get();
      if (
        !job ||
        job.status !== "running" ||
        job.leaseToken !== claim.token ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= now
      )
        return false;
      const event = db
        .select()
        .from(assistantEvent)
        .where(eq(assistantEvent.id, claim.event.id))
        .get()!;
      if (event.suppressedAt || !permitted(event, now)) {
        suppress(event.id, now);
        return false;
      }
      const summary = "summary" in result ? result.summary.trim() : "";
      const valid = summary.length > 0 && summary.length <= 800;
      if ("summary" in result && valid) {
        db.update(assistantWatchSummary)
          .set({
            status: "completed",
            summary,
            model: result.model,
            effort: result.effort,
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(assistantWatchSummary.eventId, event.id))
          .run();
      } else {
        db.update(assistantWatchSummary)
          .set({
            status: job.attempts >= SUMMARY_MAX_ATTEMPTS ? "failed" : "pending",
            error: "error" in result ? result.error.slice(0, 160) : "summary_output_invalid",
            nextAttemptAt: new Date(now.getTime() + 30_000 * 2 ** (job.attempts - 1)),
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(assistantWatchSummary.eventId, event.id))
          .run();
      }
      return true;
    })
    .immediate();
}
export function assistantWatchSummaryText(eventId: string) {
  const job = db
    .select()
    .from(assistantWatchSummary)
    .where(eq(assistantWatchSummary.eventId, eventId))
    .get();
  return job?.status === "completed"
    ? job.summary!
    : job?.status === "failed"
      ? SUMMARY_FAILURE
      : SUMMARY_LEGACY;
}
