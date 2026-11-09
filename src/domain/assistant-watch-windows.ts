import { and, eq, isNull, lte } from "drizzle-orm";
import { db, sqlite } from "../db";
import { agentRun, assistantWatch, assistantWatchCursor } from "../db/schema";
import type { RunActivity } from "../contracts/agent-run";
import { assistantSource, AssistantError, captureAssistantFact } from "./assistant";
import { getChat, ChatError } from "./chat";
import { ProjectAccessError } from "./access";

const READ_LIMIT = 50;
type WindowMessage = { id: string; sender_kind: string; body: string };

function acknowledgeTerminals(watch: typeof assistantWatch.$inferSelect, now: Date) {
  sqlite
    .prepare(`UPDATE assistant_run_cursor AS c SET terminal_captured_at=?
    WHERE c.assistant_chat_id=? AND c.terminal_captured_at IS NULL
      AND EXISTS (SELECT 1 FROM agent_run r JOIN assistant_interest i ON i.run_id=r.id
        WHERE r.id=c.run_id AND r.status NOT IN ('queued','running') AND r.queued_at*1000<=?
          AND i.assistant_chat_id=c.assistant_chat_id AND i.origin_kind='watch' AND i.origin_id=?)
      AND NOT EXISTS (SELECT 1 FROM assistant_interest pi WHERE pi.assistant_chat_id=c.assistant_chat_id AND pi.run_id=c.run_id AND pi.origin_kind='proposal')
  `)
    .run(now.getTime(), watch.assistantChatId, now.getTime(), watch.id);
}

export function sampleAssistantWatchWindows(
  now: Date,
  activity: (runId: string) => RunActivity | null | undefined,
) {
  return sqlite
    .transaction(() => {
      const due = db
        .select({ watch: assistantWatch, cursor: assistantWatchCursor })
        .from(assistantWatchCursor)
        .innerJoin(assistantWatch, eq(assistantWatch.id, assistantWatchCursor.watchId))
        .where(and(isNull(assistantWatch.revokedAt), lte(assistantWatchCursor.nextDueAt, now)))
        .orderBy(assistantWatchCursor.nextDueAt)
        .limit(100)
        .all();
      for (const { watch, cursor } of due) {
        const ctx = { userId: watch.consentedBy, requestId: "assistant-watch-digest" };
        try {
          assistantSource(watch.assistantChatId, ctx);
          const target = getChat(watch.targetChatId, ctx);
          if (target.projectId !== watch.targetProjectId || target.archivedAt)
            throw new AssistantError("forbidden");
          const boundary = sqlite
            .prepare(
              "SELECT coalesce(max(rowid),0) n FROM message WHERE chat_id=? AND created_at<=?",
            )
            .get(watch.targetChatId, Math.floor(now.getTime() / 1000)) as { n: number };
          const messages = sqlite
            .prepare(`
        SELECT m.id, m.sender_kind, m.body FROM message m
        WHERE m.chat_id=? AND m.rowid>? AND m.rowid<=?
          AND m.sender_kind IN ('human','agent','automation')
          AND NOT EXISTS (
            SELECT 1 FROM assistant_interest i JOIN assistant_proposal p ON p.id=i.origin_id
            JOIN agent_run r ON r.id=i.run_id
            WHERE i.assistant_chat_id=? AND i.origin_kind='proposal' AND p.status='submitted'
              AND (r.assistant_message_id=m.id OR EXISTS (SELECT 1 FROM agent_run_input ri WHERE ri.run_id=r.id AND ri.message_id=m.id))
          )
        ORDER BY m.rowid LIMIT ?
      `)
            .all(
              watch.targetChatId,
              cursor.messageRowid,
              boundary.n,
              watch.assistantChatId,
              READ_LIMIT + 1,
            ) as WindowMessage[];
          const runFacts: import("../contracts/assistant").AssistantWatchWindow["runs"] = [];
          let runTruncated = false;
          let offset = 0;
          for (;;) {
            const watchedRuns = sqlite
              .prepare(`
        SELECT r.id FROM agent_run r JOIN assistant_interest i ON i.run_id=r.id
        JOIN assistant_run_cursor c ON c.assistant_chat_id=i.assistant_chat_id AND c.run_id=r.id
        WHERE i.origin_kind='watch' AND i.origin_id=? AND i.assistant_chat_id=?
          AND c.terminal_captured_at IS NULL AND r.queued_at*1000<=?
          AND NOT EXISTS (SELECT 1 FROM assistant_interest pi JOIN assistant_proposal p ON p.id=pi.origin_id
            WHERE pi.assistant_chat_id=? AND pi.run_id=r.id AND pi.origin_kind='proposal' AND p.status='submitted')
        ORDER BY (r.status IN ('queued','running')),coalesce(r.settled_at,r.started_at,r.queued_at),r.id LIMIT ? OFFSET ?
      `)
              .all(
                watch.id,
                watch.assistantChatId,
                now.getTime(),
                watch.assistantChatId,
                READ_LIMIT + 1,
                offset,
              ) as { id: string }[];
            for (const row of watchedRuns) {
              const run = db.select().from(agentRun).where(eq(agentRun.id, row.id)).get()!;
              const snapshot =
                run.status === "running" || run.status === "queued"
                  ? activity(run.id)
                  : run.activity;
              const terminal = run.status !== "queued" && run.status !== "running";
              const changed =
                terminal ||
                [run.queuedAt, run.startedAt, run.settledAt].some(
                  (time) => time && time > cursor.windowStartedAt && time <= now,
                ) ||
                [
                  ...(snapshot?.entries ?? []),
                  ...(snapshot?.current ? [snapshot.current] : []),
                ].some((step) =>
                  [step.startedAt, step.finishedAt].some(
                    (time) =>
                      time && new Date(time) > cursor.windowStartedAt && new Date(time) <= now,
                  ),
                );
              if (changed) {
                if (runFacts.length === READ_LIMIT) {
                  runTruncated = true;
                  break;
                }
                runFacts.push({
                  id: run.id,
                  status: run.status,
                  error: run.errorMessage,
                  activity: snapshot ?? null,
                });
              }
            }
            if (runTruncated || watchedRuns.length < READ_LIMIT + 1) break;
            offset += watchedRuns.length;
          }
          const sampledMessages = messages.slice(0, READ_LIMIT);
          const truncated = messages.length > READ_LIMIT || runTruncated;
          if (sampledMessages.length || runFacts.length) {
            captureAssistantFact(
              watch.assistantChatId,
              `watch:${watch.id}:${cursor.nextDueAt.getTime()}`,
              {
                kind: "periodic",
                watchId: watch.id,
                targetProjectId: watch.targetProjectId,
                targetChatId: watch.targetChatId,
                sampledAt: now.toISOString(),
                watchWindow: {
                  messages: sampledMessages.map((m) => ({
                    id: m.id,
                    senderKind: m.sender_kind,
                    body: m.body,
                  })),
                  runs: runFacts,
                },
                digest: {
                  windowStartedAt: cursor.windowStartedAt.toISOString(),
                  windowEndedAt: now.toISOString(),
                  messageIds: sampledMessages.map((m) => m.id),
                  runIds: runFacts.map((r) => r.id),
                  truncated,
                },
                body: `原始关注窗口（非摘要）\n${sampledMessages.map((m) => `${m.sender_kind} · ${m.id}\n${m.body}`).join("\n\n")}\n${runFacts.map((r) => `Run · ${r.id} · ${r.status}\n${JSON.stringify(r.activity)}${r.error ? `\n${r.error}` : ""}`).join("\n\n")}${truncated ? "\n窗口活动较多，仅记录前 50 条消息和运行；请查看原对话。" : ""}`,
              },
              now,
            );
          }
          acknowledgeTerminals(watch, now);
          db.update(assistantWatchCursor)
            .set({
              windowStartedAt: now,
              nextDueAt: new Date(now.getTime() + watch.intervalSeconds * 1000),
              messageRowid: Math.max(cursor.messageRowid, boundary.n),
            })
            .where(eq(assistantWatchCursor.watchId, watch.id))
            .run();
        } catch (error) {
          if (
            !(
              error instanceof AssistantError ||
              error instanceof ChatError ||
              error instanceof ProjectAccessError
            )
          )
            throw error;
          // Permission loss closes the window instead of accumulating a later historical digest.
          const boundary = sqlite
            .prepare("SELECT coalesce(max(rowid),0) n FROM message WHERE chat_id=?")
            .get(watch.targetChatId) as { n: number };
          acknowledgeTerminals(watch, now);
          db.update(assistantWatchCursor)
            .set({
              windowStartedAt: now,
              nextDueAt: new Date(now.getTime() + watch.intervalSeconds * 1000),
              messageRowid: boundary.n,
            })
            .where(eq(assistantWatchCursor.watchId, watch.id))
            .run();
        }
      }
      return due.length;
    })
    .immediate();
}
