import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  chat,
  message,
  project,
} from "../db/schema";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { RUN_ATTENTION_SENDER_ID } from "../contracts/run-attention";
import { appendSystemOwnerRunInput } from "./agent-run";
import { readChatEffectiveMembers } from "./channel";
import { retryDelay, signalScheduleChange } from "./chat-schedule";
import { publishProjectChange } from "./change-feed";
import { readRunActivity } from "../server/pi-host/run-activity";
import type { AgentRunStatus } from "../contracts/agent-run";
import {
  resolveRunAttentionPolicy,
  type RunAttentionFacts,
  type RunAttentionPolicy,
} from "../contracts/run-attention";

type AgentRunRow = typeof agentRun.$inferSelect;
export type RunAttentionStepInput = {
  status: AgentRunStatus;
  startedAt: Date | null;
  policy: RunAttentionPolicy;
  owner: "agent" | "human" | "self";
  attentionAt: Date | null;
  humanNotifiedAt: Date | null;
  noticeNextAt: Date | null;
  now: Date;
};
export type RunAttentionStep =
  | "pending"
  | "mark_human_required"
  | "remind_owner"
  | "retry_owner"
  | "notify_human"
  | "done";

export function runAttentionStep(input: RunAttentionStepInput): RunAttentionStep {
  if (input.status !== "running" || !input.startedAt || input.humanNotifiedAt) return "done";
  const deadline = input.startedAt.getTime() + input.policy.timeoutMs;
  if (input.now.getTime() >= deadline + input.policy.escalationMs) return "notify_human";
  if (input.now.getTime() < deadline) return "pending";
  if (!input.attentionAt) return input.owner === "agent" ? "remind_owner" : "mark_human_required";
  if (input.owner === "agent" && input.noticeNextAt && input.now >= input.noticeNextAt) {
    return "retry_owner";
  }
  return "pending";
}

export function projectRunAttentionPolicy(projectId: string): RunAttentionPolicy {
  const row = db
    .select({ wakePolicy: project.wakePolicy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  return resolveRunAttentionPolicy(row?.wakePolicy?.runAttention);
}

export function runAttentionFacts(row: AgentRunRow, now: Date): RunAttentionFacts | null {
  if (!row.startedAt || !row.attentionPolicySnapshot) return null;
  const deadline = row.startedAt.getTime() + row.attentionPolicySnapshot.timeoutMs;
  const humanReminder = deadline + row.attentionPolicySnapshot.escalationMs;
  return {
    deadlineAt: new Date(deadline).toISOString(),
    humanReminderAt: new Date(humanReminder).toISOString(),
    attentionAt: row.attentionAt?.toISOString() ?? null,
    humanRequiredAt: row.humanRequiredAt?.toISOString() ?? null,
    humanNotifiedAt: row.humanNotifiedAt?.toISOString() ?? null,
    awaitingHandling:
      row.status === "running" && now.getTime() >= deadline && !!row.humanRequiredAt,
    ownerAutoAttemptsPaused: !!row.humanNotifiedAt,
  };
}

function runContext(row: AgentRunRow) {
  return db
    .select({
      chat: chat,
      profileId: agentInstance.agentProfileId,
      profileName: agentProfile.name,
      profileCreatedBy: agentProfile.createdBy,
      projectCreatedBy: project.createdBy,
    })
    .from(agentRun)
    .innerJoin(chat, and(eq(chat.id, agentRun.chatId), eq(chat.projectId, agentRun.projectId)))
    .innerJoin(agentInstance, eq(agentInstance.id, agentRun.instanceId))
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .innerJoin(project, eq(project.id, agentRun.projectId))
    .where(eq(agentRun.id, row.id))
    .get();
}

export function runAttentionHumanRecipients(row: AgentRunRow): readonly string[] {
  const context = runContext(row);
  if (!context) return [];
  const firstHuman = db
    .select({ id: message.senderId })
    .from(agentRunInput)
    .innerJoin(message, eq(message.id, agentRunInput.messageId))
    .where(and(eq(agentRunInput.runId, row.id), eq(message.senderKind, "human")))
    .orderBy(asc(message.createdAt), asc(sql`${message}.rowid`))
    .get();
  const candidates = new Set([
    context.profileCreatedBy,
    context.projectCreatedBy,
    ...(context.chat.ownerKind === "human" ? [context.chat.ownerId] : []),
    ...(firstHuman ? [firstHuman.id] : []),
  ]);
  return readChatEffectiveMembers(row.chatId, row.projectId)
    .filter(
      (member) =>
        member.memberKind === "human" &&
        candidates.has(member.memberId) &&
        member.memberId === context.projectCreatedBy,
    )
    .map((member) => member.memberId);
}

function writeNotice(row: AgentRunRow, human: boolean, now: Date): string {
  const context = runContext(row)!;
  const elapsed = Math.floor((now.getTime() - row.startedAt!.getTime()) / 60_000);
  const activity = readRunActivity(row.id)?.current ?? row.activity?.current;
  const recipients = human ? runAttentionHumanRecipients(row) : [];
  const body = `【运行注意力${human ? "：需要人类关注" : "提醒"}】Agent「${context.profileName}」的 run ${row.id} 已运行 ${elapsed} 分钟。\n${activity ? `当前可观察活动：${activity.label}${activity.detail ? `（${activity.detail}）` : ""}` : "近期无可观察事件"}。\n请在本对话的运行条目查看进度，需要时使用「停止」。提醒不会结束 run、取消远程执行或释放租约。${human ? `\n面向人类：${recipients.join("、") || "本对话有访问权的人类"}。这条消息不触发唤醒或自动接续。` : ""}`;
  const id = newId(ID_PREFIXES.message);
  db.insert(message)
    .values({
      id,
      chatId: row.chatId,
      senderKind: "agent",
      senderId: RUN_ATTENTION_SENDER_ID,
      body,
      createdAt: now,
    })
    .run();
  return id;
}

export type RunAttentionSweepResult = {
  marked: number;
  reminded: number;
  rewoken: number;
  escalated: number;
};

export function sweepRunAttention(now: Date): RunAttentionSweepResult {
  const result: RunAttentionSweepResult = { marked: 0, reminded: 0, rewoken: 0, escalated: 0 };
  const rows = db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(eq(agentRun.status, "running"))
    .all();
  for (const { id } of rows) {
    const delivery = sqlite
      .transaction(() => {
        let row = db.select().from(agentRun).where(eq(agentRun.id, id)).get();
        if (!row || row.status !== "running" || !row.startedAt || row.humanNotifiedAt) return null;
        const context = runContext(row);
        if (!context) return null;
        const snapshot = row.attentionPolicySnapshot ?? projectRunAttentionPolicy(row.projectId);
        if (!row.attentionPolicySnapshot) {
          db.update(agentRun)
            .set({ attentionPolicySnapshot: snapshot })
            .where(eq(agentRun.id, id))
            .run();
          row = { ...row, attentionPolicySnapshot: snapshot };
        }
        const owner =
          row.attentionAt &&
          snapshot.target?.kind === "agent" &&
          snapshot.target.id !== context.profileId
            ? "agent"
            : context.chat.ownerKind === "human"
              ? "human"
              : context.chat.ownerId === context.profileId
                ? "self"
                : "agent";
        const step = runAttentionStep({
          status: row.status,
          startedAt: row.startedAt,
          policy: snapshot,
          owner,
          attentionAt: row.attentionAt,
          humanNotifiedAt: row.humanNotifiedAt,
          noticeNextAt: row.attentionNoticeNextAt,
          now,
        });
        if (step === "done" || step === "pending") return null;
        if (step === "notify_human") {
          writeNotice(row, true, now);
          db.update(agentRun)
            .set({
              attentionAt: row.attentionAt ?? now,
              humanRequiredAt: row.humanRequiredAt ?? now,
              humanNotifiedAt: now,
              attentionNoticeNextAt: null,
              attentionPolicySnapshot: {
                ...snapshot,
                humanRecipientIds: [...runAttentionHumanRecipients(row)],
              },
            })
            .where(eq(agentRun.id, id))
            .run();
          result.escalated++;
          return null;
        }
        if (step === "mark_human_required") {
          db.update(agentRun)
            .set({
              attentionAt: now,
              humanRequiredAt: now,
              attentionNoticeNextAt: null,
              attentionPolicySnapshot: {
                ...snapshot,
                target: { kind: context.chat.ownerKind, id: context.chat.ownerId },
              },
            })
            .where(eq(agentRun.id, id))
            .run();
          result.marked++;
          return null;
        }
        if (step === "remind_owner") {
          const messageId = writeNotice(row, false, now);
          const fixed = {
            ...snapshot,
            target: { kind: "agent" as const, id: context.chat.ownerId },
          };
          db.update(agentRun)
            .set({
              attentionAt: now,
              attentionMessageId: messageId,
              attentionNoticeNextAt: now,
              attentionPolicySnapshot: fixed,
            })
            .where(eq(agentRun.id, id))
            .run();
          result.reminded++;
        }
        return { id, retry: step === "retry_owner" };
      })
      .immediate();
    // The message and its retry cursor are committed before attaching any input.
    if (delivery && deliverOwnerNotice(delivery.id, now) && delivery.retry) result.rewoken++;
  }
  if (result.marked + result.reminded + result.rewoken + result.escalated > 0) {
    signalScheduleChange();
    for (const { id } of rows) {
      const row = db.select().from(agentRun).where(eq(agentRun.id, id)).get();
      if (row) publishProjectChange(row.projectId, row.chatId);
    }
  }
  return result;
}

function deliverOwnerNotice(id: string, now: Date): boolean {
  return sqlite
    .transaction(() => {
      const row = db.select().from(agentRun).where(eq(agentRun.id, id)).get();
      if (
        !row ||
        row.status !== "running" ||
        row.humanNotifiedAt ||
        !row.attentionMessageId ||
        !row.attentionNoticeNextAt ||
        row.attentionNoticeNextAt > now
      )
        return false;
      const context = runContext(row);
      const target = row.attentionPolicySnapshot?.target;
      const notice = db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.id, row.attentionMessageId),
            eq(message.chatId, row.chatId),
            eq(message.senderId, RUN_ATTENTION_SENDER_ID),
          ),
        )
        .get();
      if (
        !notice ||
        !context ||
        target?.kind !== "agent" ||
        context.chat.ownerKind !== "agent" ||
        context.chat.ownerId !== target.id ||
        target.id === context.profileId ||
        !readChatEffectiveMembers(row.chatId, row.projectId).some(
          (member) => member.memberKind === "agent" && member.memberId === target.id,
        )
      ) {
        db.update(agentRun)
          .set({ humanRequiredAt: row.humanRequiredAt ?? now, attentionNoticeNextAt: null })
          .where(eq(agentRun.id, id))
          .run();
        return false;
      }
      const attempt = row.attentionNoticeAttempts + 1;
      const actingUserId = runAttentionHumanRecipients(row)[0];
      let delivered = false;
      try {
        if (actingUserId) {
          appendSystemOwnerRunInput(row.attentionMessageId, target.id, {
            userId: actingUserId,
            requestId: newId(ID_PREFIXES.request),
          });
          delivered = true;
        }
      } catch {
        // A committed notice remains retryable after membership or instance failures.
      }
      const delay = delivered ? null : retryDelay(attempt);
      db.update(agentRun)
        .set({
          attentionNoticeAttempts: attempt,
          attentionNoticeNextAt: delay === null ? null : new Date(now.getTime() + delay),
          ...(delay === null && !delivered ? { humanRequiredAt: row.humanRequiredAt ?? now } : {}),
        })
        .where(eq(agentRun.id, id))
        .run();
      return delivered;
    })
    .immediate();
}

export function nextRunAttentionDueAt(): number | null {
  let next: number | null = null;
  for (const row of db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.status, "running"), isNull(agentRun.humanNotifiedAt)))
    .all()) {
    if (!row.startedAt) continue;
    const policy = row.attentionPolicySnapshot ?? projectRunAttentionPolicy(row.projectId);
    const deadline = row.startedAt.getTime() + policy.timeoutMs;
    const humanDue = deadline + policy.escalationMs;
    const due = !row.attentionAt
      ? deadline
      : Math.min(humanDue, row.attentionNoticeNextAt?.getTime() ?? humanDue);
    if (next === null || due < next) next = due;
  }
  return next;
}
