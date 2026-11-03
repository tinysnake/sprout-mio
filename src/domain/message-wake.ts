import { randomUUID } from "node:crypto";
import { CHAT_AUTOMATION_POLICY as POLICY } from "../contracts/chat-automation";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  DEFAULT_PROJECT_WAKE_POLICY,
  projectWakePolicySchema,
} from "../contracts/project-wake-policy";
import {
  WAKE_CONTEXT_LIMITS as LIMITS,
  wakeEvaluationInputSchema,
  wakeEvaluationResultForInputSchema,
  type WakeEvaluationInput,
  type WakeEvaluationResult,
  type WakeRecipientDecision,
} from "../contracts/wake-evaluation";
import { sqlite } from "../db";
import { config } from "../lib/config";
import { readChatEffectiveMembers } from "./channel";
import {
  CLAIM_LEASE_MS,
  all,
  chatFacts,
  controlFor,
  ensureAgentInstance,
  hash,
  messageEvaluationCurrent,
  messageFingerprint,
  nextEvaluationRound,
  one,
  signalScheduleChange,
  write,
  type Evaluation,
  type SchedulerContext,
} from "./chat-schedule";
import { commitEvaluationResult, failEvaluation, type EvaluateWake } from "./continuation-delivery";
import { readMentionsFor } from "./message-mention";
import {
  prepareWakeEvaluation,
  type PreparedWakeEvaluation,
  type WakeSnapshotFacts,
} from "./wake-evaluation";

const TRAILING_DELAY_MS = 15_000;
const MAX_DELAY_MS = 60_000;
const clip = (value: string, limit: number) => Array.from(value).slice(0, limit).join("");

type MessageRow = {
  id: string;
  sender_kind: "human" | "agent";
  sender_id: string;
  body: string;
  created_at: number;
};
type RunRow = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "aborted" | "interrupted";
  at: number;
};

function runView(
  r: RunRow | undefined,
): WakeEvaluationInput["candidates"][number]["activeRun"] {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status === "interrupted" ? "failed" : r.status,
    updatedAt: new Date(r.at).toISOString(),
    pendingInputs:
      one<{ n: number }>(
        "SELECT count(*) AS n FROM agent_run_input WHERE run_id=? AND disposition='pending' AND admitted_at IS NULL",
        r.id,
      )!.n +
      one<{ n: number }>(
        "SELECT count(*) AS n FROM continuation_delivery WHERE run_id=? AND state='bound'",
        r.id,
      )!.n,
    attemptedInputs:
      one<{ n: number }>(
        "SELECT count(*) AS n FROM agent_run_input WHERE run_id=? AND admitted_at IS NOT NULL",
        r.id,
      )!.n +
      one<{ n: number }>(
        "SELECT count(*) AS n FROM continuation_delivery WHERE run_id=? AND admitted_at IS NOT NULL",
        r.id,
      )!.n,
  };
}

function readRecentMessages(chatId: string) {
  const rows = all<MessageRow>(
    "SELECT id,sender_kind,sender_id,body,created_at FROM message WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
    chatId,
    LIMITS.recentMessages,
  ).reverse();
  let budget: number = LIMITS.recentMessageCharacters;
  const recentMessages = rows
    .slice()
    .reverse()
    .map((m) => {
      const body = clip(m.body, Math.min(LIMITS.messageCharacters, budget));
      budget -= Array.from(body).length;
      return {
        id: m.id,
        kind: m.sender_kind,
        sender: { kind: m.sender_kind, id: m.sender_id },
        body,
        createdAt: new Date(m.created_at * 1000).toISOString(),
        truncated: body !== m.body,
      };
    })
    .reverse();
  const originalMessageCount = one<{ n: number }>(
    "SELECT count(*) AS n FROM message WHERE chat_id=?",
    chatId,
  )!.n;
  const droppedMessageIdRange =
    originalMessageCount > recentMessages.length
      ? {
          first: one<{ id: string }>(
            "SELECT id FROM message WHERE chat_id=? ORDER BY created_at,rowid LIMIT 1",
            chatId,
          )!.id,
          last: one<{ id: string }>(
            "SELECT id FROM message WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1 OFFSET ?",
            chatId,
            recentMessages.length,
          )!.id,
        }
      : null;
  return {
    recentMessages,
    originalMessageCount,
    droppedMessageIdRange,
    remainingCharacters: budget,
  };
}

function readAgentMembers(chatId: string, projectId: string, now: Date) {
  const members: {
    candidate: WakeEvaluationInput["candidates"][number];
    profileName: string;
    projectMember: boolean;
    effectiveMember: boolean;
  }[] = [];
  for (const member of readChatEffectiveMembers(chatId, projectId)) {
    if (member.memberKind !== "agent") continue;
    const profile = one<{ name: string; persona: string }>(
      "SELECT name,persona FROM agent_profile WHERE id=?",
      member.memberId,
    );
    const projectMember = !!one(
      "SELECT 1 FROM project_member WHERE project_id=? AND agent_profile_id=?",
      projectId,
      member.memberId,
    );
    const instanceId = ensureAgentInstance(chatId, projectId, member.memberId, now);
    const runs = all<RunRow>(
      "SELECT id,status,coalesce(settled_at,started_at,queued_at)*1000 AS at FROM agent_run WHERE instance_id=? ORDER BY queued_at DESC,rowid DESC",
      instanceId,
    );
    members.push({
      candidate: {
        recipient: { kind: "agent", id: member.memberId },
        instanceId,
        personaSummary: clip(profile?.persona ?? "", LIMITS.personaCharacters),
        responsibility: "对话成员，按对话需要被唤醒",
        activeRun: runView(runs.find((r) => r.status === "queued" || r.status === "running")),
        latestRun: runView(runs.find((r) => r.status !== "queued" && r.status !== "running")),
        externalWork: [],
      },
      profileName: profile?.name ?? "",
      projectMember,
      effectiveMember: true,
    });
  }
  return members;
}

export function buildMessageFacts(evaluation: Evaluation, now: Date): WakeSnapshotFacts {
  const chat = chatFacts(evaluation.chat_id);
  if (!chat || !evaluation.trigger_message_id) throw new Error("context_stale");
  const trigger = one<MessageRow>(
    "SELECT id,sender_kind,sender_id,body,created_at FROM message WHERE id=? AND chat_id=?",
    evaluation.trigger_message_id,
    chat.id,
  );
  if (!trigger) throw new Error("context_stale");
  const rawPolicy = one<{ wake_policy: string | null }>(
    "SELECT wake_policy FROM project WHERE id=?",
    evaluation.project_id,
  )!.wake_policy;
  const policy = projectWakePolicySchema.parse(
    rawPolicy === null ? DEFAULT_PROJECT_WAKE_POLICY : JSON.parse(rawPolicy),
  );
  const recent = readRecentMessages(chat.id);
  const mentions = readMentionsFor(chat.id, [trigger.id]).get(trigger.id) ?? [];
  const members = readAgentMembers(chat.id, chat.project_id, now);
  const input = {
    source: "message" as const,
    projectId: evaluation.project_id,
    chatId: chat.id,
    triggerId: trigger.id,
    round: evaluation.round,
    controlEpoch: evaluation.control_epoch,
    policy,
    evaluatedAt: now.toISOString(),
    triggerMessage: {
      id: trigger.id,
      kind: trigger.sender_kind,
      sender: { kind: trigger.sender_kind, id: trigger.sender_id },
      body: clip(trigger.body, LIMITS.messageCharacters),
      createdAt: new Date(trigger.created_at * 1000).toISOString(),
      truncated: clip(trigger.body, LIMITS.messageCharacters) !== trigger.body,
    },
    latestReadableMessageId: recent.recentMessages.at(-1)?.id ?? null,
    recentMessages: recent.recentMessages,
    chat: {
      kind: chat.kind,
      goal: clip(chat.title ?? "", 1000),
      collaboration: "",
      owner: { kind: chat.owner_kind, id: chat.owner_id },
      wakePolicy: chat.wake_policy,
      governanceRevision: chat.governance_revision + 1,
    },
    candidates: members.map((member) => member.candidate),
    mentions,
    tasks: [],
    truncation: {
      originalMessageCount: recent.originalMessageCount,
      includedMessageCount: recent.recentMessages.length,
      droppedMessageIdRange: recent.droppedMessageIdRange,
      tasksComplete: true as const,
      candidatesComplete: true as const,
      recentMessageCharacters: LIMITS.recentMessageCharacters - recent.remainingCharacters,
      characterBudget: LIMITS.snapshotCharacters,
    },
    snapshotHash: "0".repeat(64),
  };
  input.snapshotHash = hash({ ...input, snapshotHash: undefined });
  if (Array.from(JSON.stringify(input)).length > LIMITS.snapshotCharacters)
    throw new Error("context_budget_exceeded");
  return {
    ...wakeEvaluationInputSchema.parse({ ...input, mentions: [] }),
    mentions,
    archived: chat.archived_at !== null,
    members,
  };
}

export function buildMessageEvaluation(
  evaluation: Evaluation,
  now: Date,
): PreparedWakeEvaluation {
  return prepareWakeEvaluation(buildMessageFacts(evaluation, now), now);
}

function withOwnerFallback(
  input: WakeEvaluationInput,
  raw: WakeEvaluationResult,
): WakeEvaluationResult {
  if (raw.decision === "indeterminate" || raw.selectedRecipients.length > 0) return raw;
  if (input.chat.owner.kind !== "agent") return raw;
  const owner = input.candidates.find(
    (candidate) =>
      candidate.recipient.kind === "agent" &&
      candidate.recipient.id === input.chat.owner.id,
  );
  if (!owner) return raw;
  const recipients: WakeRecipientDecision[] = raw.recipients.map((item) =>
    item.recipient.kind === "agent" && item.recipient.id === owner.recipient.id
      ? { ...item, decision: "yes" as const }
      : item,
  );
  if (
    !recipients.some(
      (item) =>
        item.recipient.kind === "agent" && item.recipient.id === owner.recipient.id,
    )
  )
    recipients.push({
      recipient: owner.recipient,
      decision: "yes",
      reason: "owner_fallback",
      probability: null,
    });
  return wakeEvaluationResultForInputSchema(input).parse({
    ...raw,
    decision: "continue",
    selectedRecipients: [owner.recipient],
    recipients,
    reasonCode: "owner_fallback",
    reason: `${raw.reason}；判定器未选择成员，回退当前 owner。`,
    errorCode: null,
  });
}

function skipMessageEvaluation(evaluation: Evaluation, reason: string, now: Date) {
  write(
    "UPDATE wake_evaluation SET state='decided',error_code=?,evaluated_at=?,claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=? AND state='claimed' AND claim_token=?",
    reason,
    now.getTime(),
    evaluation.id,
    evaluation.claim_token,
  );
}

function finishMessageWake(evaluation: Evaluation) {
  if (!evaluation.trigger_message_id) return;
  write(
    "DELETE FROM chat_message_wake WHERE chat_id=? AND evaluation_id=? AND trigger_message_id=?",
    evaluation.chat_id,
    evaluation.id,
    evaluation.trigger_message_id,
  );
}

export function enqueueMessageWake(
  message: { readonly id: string; readonly chatId: string; readonly senderKind: "human" | "agent" },
  now: Date = new Date(),
): boolean {
  if (message.senderKind !== "human") return false;
  if (!config.SPROUT_AUTOMATION_ENABLED) return false;
  const chat = chatFacts(message.chatId);
  if (
    !chat ||
    chat.kind === "dm" ||
    chat.archived_at !== null ||
    chat.wake_policy !== "contextual" ||
    controlFor(message.chatId).mode !== "enabled"
  )
    return false;
  const mentions = readMentionsFor(message.chatId, [message.id]).get(message.id) ?? [];
  if (mentions.some((mention) => mention.memberKind === "agent")) return false;
  const at = now.getTime();
  write(
    `INSERT INTO chat_message_wake(chat_id,project_id,trigger_message_id,first_due_at,due_at,evaluation_id,created_at,updated_at)
     VALUES(?,?,?,?,?,NULL,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET
       evaluation_id=CASE WHEN chat_message_wake.trigger_message_id=excluded.trigger_message_id THEN chat_message_wake.evaluation_id ELSE NULL END,
       trigger_message_id=excluded.trigger_message_id,
       due_at=min(excluded.due_at, chat_message_wake.first_due_at + ?),
       updated_at=excluded.updated_at`,
    message.chatId,
    chat.project_id,
    message.id,
    at,
    at + TRAILING_DELAY_MS,
    at,
    at,
    MAX_DELAY_MS,
  );
  signalScheduleChange();
  return true;
}

function claimMessageEvaluation(
  evaluation: Evaluation,
  ctx: SchedulerContext,
): Evaluation {
  const token = `${ctx.workerId}:${randomUUID()}`;
  const lease = ctx.now.getTime() + CLAIM_LEASE_MS;
  write(
    "UPDATE wake_evaluation SET state='claimed',attempt=attempt+1,claim_token=?,lease_until=?,next_attempt_at=NULL WHERE id=?",
    token,
    lease,
    evaluation.id,
  );
  write(
    "UPDATE chat_message_wake SET evaluation_id=?,due_at=?,updated_at=? WHERE chat_id=? AND trigger_message_id=?",
    evaluation.id,
    lease,
    ctx.now.getTime(),
    evaluation.chat_id,
    evaluation.trigger_message_id,
  );
  return one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id)!;
}

export function claimDueMessageWake(ctx: SchedulerContext): Evaluation | undefined {
  return sqlite
    .transaction(() => {
      const now = ctx.now.getTime();
      // A message retry can outlive its wake row after a cancel/reschedule race. Requeue the
      // orphan before claiming so the retry budget still converges instead of waiting forever.
      const orphan = one<Evaluation>(
        `SELECT e.* FROM wake_evaluation e
         WHERE e.source='message' AND e.state='retry_wait' AND e.next_attempt_at IS NOT NULL
           AND e.next_attempt_at<=? AND e.trigger_message_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM chat_message_wake w WHERE w.chat_id=e.chat_id)
         ORDER BY e.next_attempt_at LIMIT 1`,
        now,
      );
      if (orphan) {
        write(
          `INSERT INTO chat_message_wake(chat_id,project_id,trigger_message_id,first_due_at,due_at,evaluation_id,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(chat_id) DO UPDATE SET
             trigger_message_id=excluded.trigger_message_id,
             first_due_at=excluded.first_due_at,
             due_at=excluded.due_at,
             evaluation_id=excluded.evaluation_id,
             updated_at=excluded.updated_at`,
          orphan.chat_id,
          orphan.project_id,
          orphan.trigger_message_id,
          orphan.next_attempt_at,
          orphan.next_attempt_at,
          orphan.id,
          now,
          now,
        );
      }
      const due = one<{
        chat_id: string;
        project_id: string;
        trigger_message_id: string;
        evaluation_id: string | null;
        due_at: number;
      }>(
        "SELECT chat_id,project_id,trigger_message_id,evaluation_id,due_at FROM chat_message_wake WHERE due_at<=? ORDER BY due_at LIMIT 1",
        ctx.now.getTime(),
      );
      if (!due) return undefined;
      const chat = chatFacts(due.chat_id);
      if (
        !chat ||
        chat.kind === "dm" ||
        chat.archived_at !== null ||
        chat.wake_policy !== "contextual" ||
        controlFor(due.chat_id).mode !== "enabled"
      ) {
        write("DELETE FROM chat_message_wake WHERE chat_id=?", due.chat_id);
        return undefined;
      }
      if (
        !one(
          "SELECT 1 FROM message WHERE id=? AND chat_id=?",
          due.trigger_message_id,
          due.chat_id,
        )
      ) {
        write("DELETE FROM chat_message_wake WHERE chat_id=?", due.chat_id);
        return undefined;
      }
      if (due.evaluation_id) {
        const previous = one<Evaluation>(
          "SELECT * FROM wake_evaluation WHERE id=?",
          due.evaluation_id,
        );
        if (
          previous?.trigger_message_id === due.trigger_message_id &&
          previous.fingerprint === messageFingerprint(due.chat_id, due.trigger_message_id) &&
          ["decided", "attention", "stale", "canceled"].includes(previous.state)
        ) {
          write("DELETE FROM chat_message_wake WHERE chat_id=?", due.chat_id);
          return undefined;
        }
      }
      let active = one<Evaluation>(
        "SELECT * FROM wake_evaluation WHERE chat_id=? AND state IN ('pending','claimed','retry_wait')",
        due.chat_id,
      );
      if (
        active?.source === "message" &&
        active.trigger_message_id !== due.trigger_message_id
      ) {
        const now = ctx.now.getTime();
        if (active.state === "claimed" && (active.lease_until ?? 0) > now) {
          write(
            "UPDATE chat_message_wake SET due_at=?,updated_at=? WHERE chat_id=?",
            active.lease_until ?? now + 1_000,
            now,
            due.chat_id,
          );
          return undefined;
        }
        write(
          "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=?",
          active.id,
        );
        active = undefined;
      }
      if (active?.source === "task_periodic") {
        write(
          "UPDATE chat_message_wake SET due_at=?,updated_at=? WHERE chat_id=?",
          ctx.now.getTime() + 1_000,
          ctx.now.getTime(),
          due.chat_id,
        );
        return undefined;
      }
      if (active) {
        if (active.attempt >= POLICY.maxAttempts) {
          write(
            "UPDATE wake_evaluation SET state='attention',error_code=coalesce(error_code,'provider_unavailable'),claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=?",
            active.id,
          );
          write("DELETE FROM chat_message_wake WHERE chat_id=?", due.chat_id);
          return undefined;
        }
        const now = ctx.now.getTime();
        const leaseHeld = active.state === "claimed" && (active.lease_until ?? 0) > now;
        const retryWaiting =
          active.state === "retry_wait" && (active.next_attempt_at ?? 0) > now;
        if (leaseHeld || retryWaiting) {
          write(
            "UPDATE chat_message_wake SET due_at=?,updated_at=? WHERE chat_id=?",
            Math.max(now + 1_000, active.lease_until ?? 0, active.next_attempt_at ?? 0),
            now,
            due.chat_id,
          );
          return undefined;
        }
        return claimMessageEvaluation(active, ctx);
      }
      const round = nextEvaluationRound(due.chat_id);
      const id = newId(ID_PREFIXES.wakeEvaluation);
      write(
        "INSERT INTO wake_evaluation(id,project_id,chat_id,source,trigger_message_id,round,control_epoch,fingerprint,state,attempt,request_id,created_at) VALUES(?,?,?,'message',?,?,?,?,'pending',0,?,?)",
        id,
        due.project_id,
        due.chat_id,
        due.trigger_message_id,
        round,
        controlFor(due.chat_id).epoch,
        messageFingerprint(due.chat_id, due.trigger_message_id),
        ctx.requestId,
        ctx.now.getTime(),
      );
      write(
        "UPDATE chat_schedule SET round=? WHERE chat_id=? AND round<?",
        round,
        due.chat_id,
        round,
      );
      return claimMessageEvaluation(
        one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", id)!,
        ctx,
      );
    })
    .immediate();
}

export async function evaluateMessageClaim(
  evaluation: Evaluation,
  evaluateWake: EvaluateWake,
  ctx: SchedulerContext,
  isActive: () => boolean = () => true,
  now: () => Date = () => ctx.now,
): Promise<void> {
  try {
    if (!messageEvaluationCurrent(evaluation)) {
      write(
        "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=? AND state='claimed' AND claim_token=?",
        evaluation.id,
        evaluation.claim_token,
      );
      write(
        "DELETE FROM chat_message_wake WHERE chat_id=? AND evaluation_id=?",
        evaluation.chat_id,
        evaluation.id,
      );
      return;
    }
    const prepared = buildMessageEvaluation(evaluation, ctx.now);
    if (prepared.kind === "skipped") {
      skipMessageEvaluation(evaluation, prepared.reasonCode, now());
      finishMessageWake(evaluation);
      return;
    }
    if (prepared.kind === "failed") {
      failEvaluation(evaluation, prepared.result.errorCode ?? "provider_invalid_response", now());
      return;
    }
    const input = prepared.input;
    write(
      "UPDATE wake_evaluation SET input=? WHERE id=? AND claim_token=?",
      JSON.stringify(input),
      evaluation.id,
      evaluation.claim_token,
    );
    const result =
      prepared.kind === "rule"
        ? prepared.result
        : withOwnerFallback(input, await evaluateWake(input));
    if (!isActive()) return;
    commitEvaluationResult(evaluation, input, result, now());
    finishMessageWake(evaluation);
  } catch (error) {
    if (!isActive()) return;
    const current = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id);
    if (
      !current ||
      current.state !== "claimed" ||
      current.claim_token !== evaluation.claim_token
    )
      return;
    if (!messageEvaluationCurrent(current)) {
      write(
        "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL WHERE id=?",
        current.id,
      );
      return;
    }
    const text = error instanceof Error ? error.message : "";
    failEvaluation(
      current,
      text === "context_budget_exceeded"
        ? "context_budget_exceeded"
        : text === "provider_unavailable"
          ? "provider_unavailable"
          : text === "context_stale"
            ? "context_stale"
            : error instanceof Error && error.name === "AbortError"
              ? "provider_timeout"
              : "provider_invalid_response",
      now(),
    );
    const after = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", current.id);
    if (after?.state === "retry_wait" && after.next_attempt_at !== null)
      write(
        "UPDATE chat_message_wake SET due_at=?,updated_at=? WHERE chat_id=? AND evaluation_id=?",
        after.next_attempt_at,
        now().getTime(),
        current.chat_id,
        current.id,
      );
    else
      write(
        "DELETE FROM chat_message_wake WHERE chat_id=? AND evaluation_id=?",
        current.chat_id,
        current.id,
      );
  } finally {
    signalScheduleChange();
  }
}

export function reconcileMessageWake(chatId: string, _now: Date): void {
  const chat = chatFacts(chatId);
  if (!chat) return;
  const control = controlFor(chatId);
  if (
    control.mode === "enabled" &&
    chat.archived_at === null &&
    chat.kind !== "dm" &&
    chat.wake_policy === "contextual"
  )
    return;
  const reason =
    control.mode === "off"
      ? "human_disabled"
      : chat.archived_at !== null
        ? "chat_archived"
        : "policy_changed";
  write("DELETE FROM chat_message_wake WHERE chat_id=?", chatId);
  write(
    "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=? AND source='message' AND state IN ('pending','claimed','retry_wait')",
    chatId,
  );
  write(
    "UPDATE continuation_delivery SET state='canceled',cancel_reason=?,next_attempt_at=NULL WHERE chat_id=? AND state IN ('pending','bound') AND admitted_at IS NULL AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE chat_id=? AND source='message')",
    reason,
    chatId,
    chatId,
  );
  signalScheduleChange();
}

export function retryMessageWake(evaluation: Evaluation, now: Date): boolean {
  if (evaluation.source !== "message" || !evaluation.trigger_message_id) return false;
  const queued = one<{ trigger_message_id: string }>(
    "SELECT trigger_message_id FROM chat_message_wake WHERE chat_id=?",
    evaluation.chat_id,
  );
  if (queued && queued.trigger_message_id !== evaluation.trigger_message_id) return false;
  const at = now.getTime();
  write(
    `INSERT INTO chat_message_wake(chat_id,project_id,trigger_message_id,first_due_at,due_at,evaluation_id,created_at,updated_at)
     VALUES(?,?,?,?,?,NULL,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET
       trigger_message_id=excluded.trigger_message_id,
       first_due_at=excluded.first_due_at,
       due_at=excluded.due_at,
       evaluation_id=NULL,
       updated_at=excluded.updated_at`,
    evaluation.chat_id,
    evaluation.project_id,
    evaluation.trigger_message_id,
    at,
    at,
    at,
    at,
  );
  signalScheduleChange();
  return true;
}

export function messageWakeDue(chatId: string): number | null {
  return (
    one<{ due: number }>("SELECT due_at AS due FROM chat_message_wake WHERE chat_id=?", chatId)
      ?.due ?? null
  );
}
