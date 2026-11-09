import { and, eq, isNull, or, lte, ne, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  agentRun,
  agentRunInput,
  assistantEvent,
  assistantPreferences,
  assistantProposal,
  assistantInterest,
  assistantRunCursor,
  assistantWatch,
  chat,
  project,
} from "../db/schema";
import type { RunActivity } from "../contracts/agent-run";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  assistantSource,
  AssistantError,
  captureAssistantFact,
  deliverAssistantEvents,
  hasCurrentAssistantInterest,
} from "./assistant";
import {
  enrollExistingWatch,
  assistantRunInterval,
  rescheduleWatch,
  stopAssistantWatch,
  resolveWatchIntents,
} from "./assistant-interest";
import { sampleAssistantWatchWindows } from "./assistant-watch-windows";
import { getChat, ChatError } from "./chat";
import { ProjectAccessError, type ProjectContext } from "./access";
import { readRunActivity } from "../server/pi-host/run-activity";

export function setAssistantWatch(
  assistantChatId: string,
  targetProjectId: string,
  targetChatId: string,
  active: boolean,
  ctx: ProjectContext,
  now = new Date(),
  intervalSeconds?: number,
  eventId?: string,
) {
  if (
    intervalSeconds !== undefined &&
    (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400)
  )
    throw new AssistantError("conflict");
  return sqlite
    .transaction(() => {
      assistantSource(assistantChatId, ctx);
      const current = db
        .select()
        .from(assistantWatch)
        .where(
          and(
            eq(assistantWatch.assistantChatId, assistantChatId),
            eq(assistantWatch.targetChatId, targetChatId),
            eq(assistantWatch.targetProjectId, targetProjectId),
            isNull(assistantWatch.revokedAt),
          ),
        )
        .get();
      if (!active) {
        const stopped = stopAssistantWatch(
          assistantChatId,
          targetProjectId,
          targetChatId,
          ctx.userId,
          now,
        );
        deliverAssistantEvents(now);
        return stopped;
      }
      if (eventId) {
        const intent = db.select().from(assistantEvent).where(eq(assistantEvent.id, eventId)).get();
        if (
          !intent ||
          intent.assistantChatId !== assistantChatId ||
          !intent.fact.watchIntent ||
          intent.fact.targetProjectId !== targetProjectId ||
          intent.fact.targetChatId !== targetChatId ||
          (intent.decisionResolvedAt &&
            (!current || intent.decisionResolvedAt.getTime() !== current.consentedAt.getTime())) ||
          (intervalSeconds !== undefined && intent.fact.intervalSeconds !== intervalSeconds)
        )
          throw new AssistantError("conflict", "关注意图已处理，请提出新的关注请求");
        intervalSeconds = intent.fact.intervalSeconds;
      }
      const target = getChat(targetChatId, ctx);
      if (target.projectId !== targetProjectId || target.archivedAt)
        throw new AssistantError("not_found");
      resolveWatchIntents(assistantChatId, targetProjectId, targetChatId, now);
      if (current) {
        if (intervalSeconds !== undefined) {
          db.update(assistantWatch)
            .set({ intervalSeconds })
            .where(eq(assistantWatch.id, current.id))
            .run();
          rescheduleWatch({ ...current, intervalSeconds }, now);
        }
        return { active: true, watchId: current.id };
      }
      const watch = {
        id: newId(ID_PREFIXES.message),
        assistantChatId,
        targetProjectId,
        targetChatId,
        consentedBy: ctx.userId,
        consentedAt: now,
        intervalSeconds: intervalSeconds ?? 300,
      };
      db.insert(assistantWatch).values(watch).run();
      enrollExistingWatch({ ...watch, revokedAt: null }, now);
      rescheduleWatch({ ...watch, revokedAt: null }, now);
      return { active: true, watchId: watch.id };
    })
    .immediate();
}
export function setAssistantInterval(
  assistantChatId: string,
  intervalSeconds: number,
  ctx: ProjectContext,
) {
  assistantSource(assistantChatId, ctx);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400)
    throw new AssistantError("conflict");
  sqlite
    .transaction(() => {
      db.insert(assistantPreferences)
        .values({ assistantChatId, intervalSeconds })
        .onConflictDoUpdate({
          target: assistantPreferences.assistantChatId,
          set: { intervalSeconds },
        })
        .run();
    })
    .immediate();
  return { intervalSeconds };
}
function captureUndeliveredProposals(now: Date) {
  const proposals = db
    .select()
    .from(assistantProposal)
    .where(
      and(
        eq(assistantProposal.status, "submitted"),
        sql`not exists (select 1 from assistant_event e where e.assistant_chat_id=${assistantProposal.assistantChatId} and e.event_key='proposal:' || ${assistantProposal.id} || ':undelivered')`,
        sql`not exists (select 1 from agent_run_input i where i.message_id=${assistantProposal.workMessageId} and i.admitted_at is not null)`,
        sql`exists (select 1 from agent_run_input i join agent_run r on r.id=i.run_id where i.message_id=${assistantProposal.workMessageId} and (i.disposition != 'pending' or r.status not in ('queued','running')))`,
        sql`not exists (select 1 from agent_run_input i join agent_run r on r.id=i.run_id where i.message_id=${assistantProposal.workMessageId} and i.disposition='pending' and r.status in ('queued','running'))`,
      ),
    )
    .limit(100)
    .all();
  for (const proposal of proposals) {
    if (!proposal.workMessageId) continue;
    const inputs = db
      .select({ input: agentRunInput, run: agentRun })
      .from(agentRunInput)
      .innerJoin(agentRun, eq(agentRun.id, agentRunInput.runId))
      .where(eq(agentRunInput.messageId, proposal.workMessageId))
      .all();
    if (
      !inputs.length ||
      inputs.some(
        ({
          input,
          run,
        }: {
          input: typeof agentRunInput.$inferSelect;
          run: typeof agentRun.$inferSelect;
        }) =>
          input.admittedAt ||
          (input.disposition === "pending" && ["queued", "running"].includes(run.status)),
      )
    )
      continue;
    const ctx = { userId: proposal.humanId, requestId: "assistant-observer" };
    let permitted = true;
    try {
      assistantSource(proposal.assistantChatId, ctx);
      getChat(proposal.targetChatId, ctx);
    } catch (error) {
      if (
        !(
          error instanceof AssistantError ||
          error instanceof ProjectAccessError ||
          error instanceof ChatError
        )
      )
        throw error;
      permitted = false;
    }
    const event = captureAssistantFact(
      proposal.assistantChatId,
      `proposal:${proposal.id}:undelivered`,
      {
        kind: "intervention",
        proposalId: proposal.id,
        targetProjectId: proposal.targetProjectId,
        targetChatId: proposal.targetChatId,
        sampledAt: now.toISOString(),
        body: `已确认工作未送达 Agent。${inputs.map(({ input, run }: { input: typeof agentRunInput.$inferSelect; run: typeof agentRun.$inferSelect }) => `${run.id}: ${input.disposition}, ${input.cancelReason ?? run.status}`).join("; ")}。未重试工作。`,
      },
      now,
    );
    if (!permitted)
      db.update(assistantEvent)
        .set({ suppressedAt: now })
        .where(eq(assistantEvent.id, event.id))
        .run();
  }
}
function activityFact(snapshot: RunActivity | undefined | null, terminal: boolean, now: Date) {
  if (!snapshot) return terminal ? "无已保存活动记录" : "实时活动暂不可用";
  const steps = snapshot.current ? [snapshot.current] : snapshot.entries.slice(0, 3);
  return steps.length
    ? steps
        .map((step) => {
          const duration =
            step.durationMs ??
            (step.finishedAt
              ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
              : step.status === "running"
                ? now.getTime() - new Date(step.startedAt).getTime()
                : undefined);
          const timing =
            duration === undefined
              ? "动作耗时暂不可用"
              : `动作${step.status === "running" ? "已进行" : "耗时"} ${Math.max(0, Math.floor(duration / 1000))}s`;
          return `${step.label} · ${step.status} · ${timing}${step.detail ? ` · ${step.detail.slice(0, 500)}` : ""}`;
        })
        .join("\n")
    : "暂无活动记录";
}
export function sampleAssistantRuns(now: Date, activity = readRunActivity) {
  return sqlite
    .transaction(() => {
      const rows = db
        .select({ cursor: assistantRunCursor, run: agentRun })
        .from(assistantRunCursor)
        .innerJoin(agentRun, eq(agentRun.id, assistantRunCursor.runId))
        .where(
          and(
            isNull(assistantRunCursor.terminalCapturedAt),
            sql`exists (select 1 from ${assistantInterest} i join ${assistantProposal} p on p.id=i.origin_id where i.assistant_chat_id=${assistantRunCursor.assistantChatId} and i.run_id=${assistantRunCursor.runId} and i.origin_kind='proposal' and p.status='submitted')`,
            or(
              lte(assistantRunCursor.nextDueAt, now),
              and(ne(agentRun.status, "queued"), ne(agentRun.status, "running")),
            ),
          ),
        )
        .limit(100)
        .all();
      for (const { cursor, run } of rows) {
        const terminal = run.status !== "queued" && run.status !== "running";
        const owner = db
          .select({ userId: project.createdBy })
          .from(chat)
          .innerJoin(project, eq(project.id, chat.projectId))
          .where(eq(chat.id, cursor.assistantChatId))
          .get();
        try {
          if (!owner || !hasCurrentAssistantInterest(cursor.assistantChatId, run.id)) continue;
          const ctx = { userId: owner.userId, requestId: "assistant-observer" };
          assistantSource(cursor.assistantChatId, ctx);
          const target = getChat(run.chatId, ctx);
          if (target.projectId !== run.projectId || target.archivedAt) continue;
          const snapshot = terminal ? run.activity : activity(run.id);
          const elapsed = Math.max(
            0,
            Math.floor((now.getTime() - (run.startedAt ?? run.queuedAt).getTime()) / 1000),
          );
          const kind = terminal
            ? run.status === "completed"
              ? "completed"
              : "intervention"
            : "periodic";
          captureAssistantFact(
            cursor.assistantChatId,
            `${run.id}:${terminal ? "terminal" : cursor.nextDueAt.getTime()}`,
            {
              kind,
              runId: run.id,
              runState: { status: run.status, elapsedSeconds: elapsed },
              targetProjectId: run.projectId,
              targetChatId: run.chatId,
              sampledAt: now.toISOString(),
              ...(!terminal && snapshot?.current
                ? {
                    action: {
                      label: snapshot.current.label,
                      elapsedSeconds: Math.max(
                        0,
                        Math.floor(
                          (now.getTime() - new Date(snapshot.current.startedAt).getTime()) / 1000,
                        ),
                      ),
                    },
                  }
                : {}),
              body: `Run ${run.id} · ${run.status} · 已经过 ${elapsed}s\n${activityFact(snapshot, terminal, now)}${run.errorMessage ? `\n${run.errorMessage}` : ""}${terminal && !run.assistantMessageId ? "\n无最终回复；不推断为业务成功" : ""}`,
            },
            now,
          );
        } catch (error) {
          if (
            !(
              error instanceof AssistantError ||
              error instanceof ProjectAccessError ||
              error instanceof ChatError
            )
          )
            throw error;
        } finally {
          const seconds = assistantRunInterval(cursor.assistantChatId, cursor.runId);
          db.update(assistantRunCursor)
            .set({
              nextDueAt: new Date(now.getTime() + seconds * 1000),
              ...(terminal ? { terminalCapturedAt: now } : {}),
            })
            .where(
              and(
                eq(assistantRunCursor.assistantChatId, cursor.assistantChatId),
                eq(assistantRunCursor.runId, run.id),
              ),
            )
            .run();
        }
      }
      sampleAssistantWatchWindows(now, activity);
      captureUndeliveredProposals(now);
      deliverAssistantEvents(now);
      return rows.length;
    })
    .immediate();
}
