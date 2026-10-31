import { randomUUID } from "node:crypto";
import { sqlite } from "../db";
import {
  CHAT_AUTOMATION_POLICY as POLICY,
  continuationDeliverySchema,
  continuationInputEnvelopeSchema,
  type ContinuationDelivery,
  type ContinuationInputEnvelope,
} from "../contracts/chat-automation";
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
  type WakeEvaluationErrorCode,
} from "../contracts/wake-evaluation";
import { allocateContinuationRun } from "./agent-run";
import {
  all,
  one,
  write,
  hash,
  iso,
  chatFacts,
  assignedTasks,
  responsibleRecipient,
  deliveryContextMatches,
  hasUnknownDeliveryBarrier,
  controlFor,
  evaluationCurrent,
  reconcileChatSchedule,
  retryDelay,
  signalScheduleChange,
  INTERVAL_MS,
  type Evaluation,
  type SchedulerContext,
} from "./chat-schedule";

/** Integration supplies judge's evaluator. This layer never chooses or calls a provider itself. */
export type EvaluateWake = (input: WakeEvaluationInput) => Promise<WakeEvaluationResult>;
export type DeliveryRow = {
  id: string;
  evaluation_id: string;
  project_id: string;
  chat_id: string;
  recipient_kind: "agent" | "human";
  recipient_id: string;
  instance_id: string | null;
  run_id: string | null;
  control_epoch: number;
  snapshot_hash: string;
  fingerprint: string;
  state: ContinuationDelivery["state"];
  attempt: number;
  envelope: string | null;
  created_at: number;
  admitted_at: number | null;
  delivered_at: number | null;
  presented_at: number | null;
  next_attempt_at: number | null;
  cancel_reason: ContinuationDelivery["cancelReason"];
  error_code: WakeEvaluationErrorCode | null;
  supersedes_delivery_id: string | null;
};
const clip = (value: string, limit: number) => Array.from(value).slice(0, limit).join("");
export function buildPeriodicInput(evaluation: Evaluation, now: Date): WakeEvaluationInput {
  const chat = chatFacts(evaluation.chat_id)!;
  const owner = responsibleRecipient(chat.id);
  if (!owner) throw new Error("context_stale");
  const rawPolicy = one<{ wake_policy: string | null }>(
    "SELECT wake_policy FROM project WHERE id=?",
    evaluation.project_id,
  )!.wake_policy;
  const policy = projectWakePolicySchema.parse(
    rawPolicy === null ? DEFAULT_PROJECT_WAKE_POLICY : JSON.parse(rawPolicy),
  );
  const runs = owner.instanceId
    ? all<{
        id: string;
        status: "queued" | "running" | "completed" | "failed" | "aborted" | "interrupted";
        at: number;
      }>(
        "SELECT id,status,coalesce(settled_at,started_at,queued_at)*1000 AS at FROM agent_run WHERE instance_id=? ORDER BY queued_at DESC,rowid DESC",
        owner.instanceId,
      )
    : [];
  const runView = (
    r: (typeof runs)[number] | undefined,
  ): WakeEvaluationInput["candidates"][number]["activeRun"] =>
    r
      ? {
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
        }
      : null;
  const records = (taskId: string) =>
    one<{
      id: string;
      task_record_seq: number;
      task_record_kind: "start" | "progress" | "correction";
      body: string;
    }>(
      "SELECT * FROM message WHERE task_id=? AND chat_id=? ORDER BY task_record_seq DESC LIMIT 1",
      taskId,
      chat.id,
    );
  const tasks = assignedTasks(chat.id).map((t) => {
    const last = records(t.id);
    const body = last ? clip(last.body, LIMITS.taskCharacters - Array.from(t.title).length) : "";
    return {
      id: t.id,
      title: t.title,
      status: "assigned" as const,
      revision: t.revision,
      assignmentRevision: t.assignment_revision,
      chatId: chat.id,
      responsibility: { kind: owner.kind, id: owner.id },
      checklistTotal: one<{ n: number }>(
        "SELECT count(*) AS n FROM task_checklist_item WHERE task_id=? AND removed_at IS NULL",
        t.id,
      )!.n,
      checklistChecked: one<{ n: number }>(
        "SELECT count(*) AS n FROM task_checklist_item WHERE task_id=? AND removed_at IS NULL AND checked=1",
        t.id,
      )!.n,
      recordCount: one<{ n: number }>("SELECT count(*) AS n FROM message WHERE task_id=?", t.id)!.n,
      lastRecord: last
        ? {
            id: last.id,
            seq: last.task_record_seq,
            kind: last.task_record_kind,
            body,
            truncated: body !== last.body,
          }
        : null,
      previousCompletionRef:
        one<{ messageId: string; seq: number; chatId: string }>(
          "SELECT m.id AS messageId,m.task_record_seq AS seq,m.chat_id AS chatId FROM task_event e JOIN message m ON m.task_id=e.task_id AND m.task_record_seq=e.record_seq_at_event WHERE e.task_id=? AND e.action IN ('complete','correct') AND e.to_status='finished' AND m.chat_id=? ORDER BY e.seq DESC LIMIT 1",
          t.id,
          chat.id,
        ) ?? null,
    };
  });
  const messages = all<{
    id: string;
    sender_kind: "human" | "agent";
    sender_id: string;
    body: string;
    created_at: number;
  }>(
    "SELECT * FROM message WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
    chat.id,
    LIMITS.recentMessages,
  ).reverse();
  let budget = LIMITS.recentMessageCharacters;
  const recentMessages = messages
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
    chat.id,
  )!.n;
  const droppedMessageIdRange =
    originalMessageCount > recentMessages.length
      ? {
          first: one<{ id: string }>(
            "SELECT id FROM message WHERE chat_id=? ORDER BY created_at,rowid LIMIT 1",
            chat.id,
          )!.id,
          last: one<{ id: string }>(
            "SELECT id FROM message WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1 OFFSET ?",
            chat.id,
            recentMessages.length,
          )!.id,
        }
      : null;
  const externalWork: WakeEvaluationInput["candidates"][number]["externalWork"][number][] = [];
  if (owner.instanceId) {
    for (const lease of all<{ machine_id: string; generation: number; state: "held" | "fencing" }>(
      "SELECT machine_id,generation,state FROM machine_lease WHERE project_id=? AND holder_instance_id=? AND state IN ('held','fencing') ORDER BY machine_id",
      chat.project_id,
      owner.instanceId,
    ))
      externalWork.push({
        kind: "lease",
        id: `${lease.machine_id}:${lease.generation}`,
        projectId: chat.project_id,
        state: lease.state === "held" ? "active" : "draining",
        summary: `Machine ${lease.machine_id} 租约：${lease.state}`,
      });
    for (const execution of all<{
      id: string;
      state: "queued" | "dispatched" | "running" | "draining" | "unknown";
    }>(
      "SELECT id,state FROM remote_execution WHERE project_id=? AND holder_instance_id=? AND state IN ('queued','dispatched','running','draining','unknown') ORDER BY id",
      chat.project_id,
      owner.instanceId,
    ))
      externalWork.push({
        kind: "execution",
        id: execution.id,
        projectId: chat.project_id,
        state: execution.state === "dispatched" ? "queued" : execution.state,
        summary: `远端执行：${execution.state}`,
      });
  }
  const profile =
    owner.kind === "agent"
      ? one<{ persona: string }>("SELECT persona FROM agent_profile WHERE id=?", owner.id)
      : null;
  const input = {
    source: "task_periodic" as const,
    projectId: chat.project_id,
    chatId: chat.id,
    triggerId: evaluation.id,
    round: evaluation.round,
    controlEpoch: evaluation.control_epoch,
    policy,
    evaluatedAt: now.toISOString(),
    triggerMessage: null,
    latestReadableMessageId: recentMessages.at(-1)?.id ?? null,
    recentMessages,
    chat: {
      kind: chat.kind,
      goal: clip(chat.title ?? "", 1000),
      collaboration: "",
      owner: { kind: owner.kind, id: owner.id },
      wakePolicy: chat.wake_policy,
      governanceRevision: chat.governance_revision + 1,
    },
    candidates: [
      {
        recipient: { kind: owner.kind, id: owner.id },
        instanceId: owner.instanceId,
        personaSummary: clip(profile?.persona ?? "", LIMITS.personaCharacters),
        responsibility: "负责推进此 Chat 的 assigned Tasks",
        activeRun: runView(runs.find((r) => r.status === "queued" || r.status === "running")),
        latestRun: runView(runs.find((r) => r.status !== "queued" && r.status !== "running")),
        externalWork,
      },
    ],
    tasks,
    truncation: {
      originalMessageCount,
      includedMessageCount: recentMessages.length,
      droppedMessageIdRange,
      tasksComplete: true as const,
      candidatesComplete: true as const,
      recentMessageCharacters: LIMITS.recentMessageCharacters - budget,
      characterBudget: LIMITS.snapshotCharacters,
    },
    snapshotHash: "0".repeat(64),
  };
  input.snapshotHash = hash({ ...input, snapshotHash: undefined });
  if (Array.from(JSON.stringify(input)).length > LIMITS.snapshotCharacters)
    throw new Error("context_budget_exceeded");
  return wakeEvaluationInputSchema.parse(input);
}

export function deliveryView(row: DeliveryRow): ContinuationDelivery {
  return continuationDeliverySchema.parse({
    deliveryId: row.id,
    evaluationId: row.evaluation_id,
    projectId: row.project_id,
    chatId: row.chat_id,
    recipient: { kind: row.recipient_kind, id: row.recipient_id },
    instanceId: row.instance_id,
    runId: row.run_id,
    controlEpoch: row.control_epoch,
    snapshotHash: row.snapshot_hash,
    state: row.state,
    attempt: row.attempt,
    taskIds: all<{ task_id: string }>(
      "SELECT task_id FROM continuation_delivery_task WHERE delivery_id=? ORDER BY task_id",
      row.id,
    ).map((t) => t.task_id),
    createdAt: iso(row.created_at),
    admittedAt: iso(row.admitted_at),
    deliveredAt: iso(row.delivered_at),
    presentedAt: iso(row.presented_at),
    nextAttemptAt: iso(row.next_attempt_at),
    cancelReason: row.cancel_reason,
    errorCode: row.error_code,
    supersedesDeliveryId: row.supersedes_delivery_id,
  });
}
export function deliveryCurrent(row: DeliveryRow) {
  const control = controlFor(row.chat_id);
  return (
    control.mode === "enabled" && control.epoch === row.control_epoch && deliveryContextMatches(row)
  );
}
function cancelInvalid(row: DeliveryRow) {
  const mode = controlFor(row.chat_id).mode;
  write(
    "UPDATE continuation_delivery SET state='canceled',cancel_reason=?,next_attempt_at=NULL WHERE id=? AND admitted_at IS NULL AND state IN ('pending','bound')",
    mode === "off" ? "human_disabled" : "task_context_changed",
    row.id,
  );
}
/** Second epoch gate: result completion and input allocation are a single transaction. */
export function commitEvaluationResult(
  evaluation: Evaluation,
  input: WakeEvaluationInput,
  raw: WakeEvaluationResult,
  now: Date,
): string | null {
  return sqlite
    .transaction(() => {
      const current = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id)!;
      if (current.state !== "claimed" || current.claim_token !== evaluation.claim_token)
        return null;
      if (!evaluationCurrent(current)) {
        write(
          "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL WHERE id=?",
          current.id,
        );
        reconcileChatSchedule(current.chat_id, now);
        return null;
      }
      const result = wakeEvaluationResultForInputSchema(input).parse(raw);
      write(
        "UPDATE wake_evaluation SET input=?,result=?,evaluated_at=? WHERE id=?",
        JSON.stringify(input),
        JSON.stringify(result),
        now.getTime(),
        current.id,
      );
      if (result.decision === "indeterminate") {
        failEvaluation(current, result.errorCode ?? "provider_low_certainty", now);
        return null;
      }
      write(
        "UPDATE wake_evaluation SET state='decided',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL,error_code=NULL WHERE id=?",
        current.id,
      );
      write(
        "UPDATE chat_schedule SET next_due_at=?,updated_at=? WHERE chat_id=?",
        now.getTime() + INTERVAL_MS,
        now.getTime(),
        current.chat_id,
      );
      if (result.decision !== "continue") return null;
      return createContinuationDelivery(current, input, result, now);
    })
    .immediate();
}
/** Caller holds the writer transaction. Scheduled inputs are exclusively addressed to current responsibility. */
export function createContinuationDelivery(
  evaluation: Evaluation,
  input: WakeEvaluationInput,
  result: WakeEvaluationResult,
  now: Date,
  supersedes: string | null = null,
): string | null {
  if (!evaluationCurrent(evaluation) || controlFor(evaluation.chat_id).epoch !== input.controlEpoch)
    return null;
  const owner = responsibleRecipient(evaluation.chat_id)!;
  if (!result.selectedRecipients.some((r) => r.kind === owner.kind && r.id === owner.id))
    return null;
  const existing = one<DeliveryRow>(
    "SELECT * FROM continuation_delivery WHERE chat_id=? AND (state IN ('pending','bound') OR (fingerprint=? AND state IN ('admitted','delivered','presented'))) ORDER BY created_at DESC LIMIT 1",
    evaluation.chat_id,
    evaluation.fingerprint,
  );
  if (existing && !supersedes) {
    if (existing.state === "pending" || existing.state === "bound") {
      // A fresh periodic conclusion may retry a failed run. Its terminal callback never does.
      const active =
        existing.run_id !== null &&
        one(
          "SELECT 1 FROM agent_run WHERE id=? AND status IN ('queued','running')",
          existing.run_id,
        );
      const envelope =
        active && existing.envelope
          ? {
              ...JSON.parse(existing.envelope),
              evaluationId: evaluation.id,
              snapshotHash: input.snapshotHash,
            }
          : null;
      write(
        "UPDATE continuation_delivery SET evaluation_id=?,snapshot_hash=?,fingerprint=?,state=?,run_id=?,envelope=? WHERE id=? AND admitted_at IS NULL",
        evaluation.id,
        input.snapshotHash,
        evaluation.fingerprint,
        active ? "bound" : "pending",
        active ? existing.run_id : null,
        envelope ? JSON.stringify(envelope) : null,
        existing.id,
      );
      write("DELETE FROM continuation_delivery_task WHERE delivery_id=?", existing.id);
      for (const t of input.tasks)
        write(
          "INSERT INTO continuation_delivery_task VALUES(?,?,?)",
          existing.id,
          t.id,
          evaluation.project_id,
        );
    }
    return existing.id;
  }
  if (!supersedes && hasUnknownDeliveryBarrier(evaluation.chat_id)) return null;
  const id = `delivery_${randomUUID()}`;
  write(
    "INSERT INTO continuation_delivery(id,evaluation_id,project_id,chat_id,recipient_kind,recipient_id,instance_id,control_epoch,snapshot_hash,fingerprint,state,created_at,presented_at,supersedes_delivery_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    evaluation.id,
    evaluation.project_id,
    evaluation.chat_id,
    owner.kind,
    owner.id,
    owner.instanceId,
    evaluation.control_epoch,
    input.snapshotHash,
    evaluation.fingerprint,
    owner.kind === "human" ? "presented" : "pending",
    now.getTime(),
    owner.kind === "human" ? now.getTime() : null,
    supersedes,
  );
  for (const t of input.tasks)
    write("INSERT INTO continuation_delivery_task VALUES(?,?,?)", id, t.id, evaluation.project_id);
  signalScheduleChange();
  return id;
}
export function failEvaluation(evaluation: Evaluation, error: WakeEvaluationErrorCode, now: Date) {
  const retryable = ["provider_timeout", "provider_unavailable", "internal_failure"].includes(
    error,
  );
  const delay = retryable ? retryDelay(evaluation.attempt) : null;
  write(
    "UPDATE wake_evaluation SET state=?,error_code=?,claim_token=NULL,lease_until=NULL,next_attempt_at=?,evaluated_at=? WHERE id=? AND state='claimed' AND claim_token=?",
    delay === null ? "attention" : "retry_wait",
    error,
    delay === null ? null : now.getTime() + delay,
    now.getTime(),
    evaluation.id,
    evaluation.claim_token,
  );
  write(
    "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
    delay === null ? null : now.getTime() + delay,
    evaluation.chat_id,
  );
  signalScheduleChange();
}
export async function evaluateClaim(
  evaluation: Evaluation,
  evaluateWake: EvaluateWake,
  ctx: SchedulerContext,
  isActive: () => boolean = () => true,
  now: () => Date = () => ctx.now,
) {
  let input: WakeEvaluationInput;
  try {
    if (!evaluationCurrent(evaluation)) return;
    input = buildPeriodicInput(evaluation, ctx.now);
    // The durable input is written before external work; no database transaction crosses await.
    write(
      "UPDATE wake_evaluation SET input=? WHERE id=? AND claim_token=?",
      JSON.stringify(input),
      evaluation.id,
      evaluation.claim_token,
    );
    const result = await evaluateWake(input);
    if (!isActive()) return;
    commitEvaluationResult(evaluation, input, result, now());
  } catch (error) {
    if (!isActive()) return;
    const current = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id)!;
    if (current.state !== "claimed" || current.claim_token !== evaluation.claim_token) return;
    if (!evaluationCurrent(current)) {
      write(
        "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL WHERE id=?",
        current.id,
      );
      return;
    }
    const message = error instanceof Error ? error.message : "";
    failEvaluation(
      current,
      message === "context_budget_exceeded"
        ? "context_budget_exceeded"
        : message === "provider_unavailable"
          ? "provider_unavailable"
          : message === "context_stale"
            ? "context_stale"
            : error instanceof Error && error.name === "AbortError"
              ? "provider_timeout"
              : "provider_invalid_response",
      now(),
    );
  } finally {
    signalScheduleChange();
  }
}
export function bindPendingDeliveries(now: Date) {
  for (const row of all<DeliveryRow>(
    "SELECT * FROM continuation_delivery WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)",
    now.getTime(),
  )) {
    sqlite
      .transaction(() => {
        const current = one<DeliveryRow>("SELECT * FROM continuation_delivery WHERE id=?", row.id)!;
        if (current.state !== "pending") return;
        if (!deliveryCurrent(current)) {
          cancelInvalid(current);
          return;
        }
        // Three successive failed/interrupted rounds require Human attention instead of a run loop.
        const failures = all<{ status: string }>(
          "SELECT status FROM agent_run WHERE instance_id=? ORDER BY queued_at DESC,rowid DESC LIMIT ?",
          row.instance_id,
          POLICY.repeatedRunFailureLimit,
        );
        if (
          failures.length === POLICY.repeatedRunFailureLimit &&
          failures.every((r) => ["failed", "interrupted"].includes(r.status))
        ) {
          write(
            "UPDATE continuation_delivery SET state='attention',error_code='run_repeated_failure',next_attempt_at=NULL WHERE id=?",
            row.id,
          );
          write("UPDATE chat_schedule SET next_due_at=NULL WHERE chat_id=?", row.chat_id);
          return;
        }
        try {
          const run = allocateContinuationRun(
            {
              instanceId: current.instance_id!,
              chatId: current.chat_id,
              projectId: current.project_id,
            },
            `req_${randomUUID()}`,
            now,
          );
          const evaluation = one<Evaluation>(
            "SELECT * FROM wake_evaluation WHERE id=?",
            current.evaluation_id,
          )!;
          const input = JSON.parse(evaluation.input!) as WakeEvaluationInput;
          const envelope = continuationInputEnvelopeSchema.parse({
            kind: "continuation",
            deliveryId: current.id,
            evaluationId: current.evaluation_id,
            projectId: current.project_id,
            chatId: current.chat_id,
            runId: run.id,
            instanceId: current.instance_id,
            controlEpoch: current.control_epoch,
            snapshotHash: current.snapshot_hash,
            source: "task_periodic",
            taskIds: input.tasks.map((t) => t.id),
            recordRefs: input.tasks.flatMap((t) =>
              t.lastRecord
                ? [{ messageId: t.lastRecord.id, chatId: t.chatId, seq: t.lastRecord.seq }]
                : [],
            ),
            body: `这是自动接续工作指令。请结合当前进展继续负责的 Task；按实际工作追加施工记录，达到完成要求后完成 Task。\n${input.tasks.map((t) => `${t.id}: ${t.title}`).join("\n")}\n判定理由：${(JSON.parse(evaluation.result!) as WakeEvaluationResult).reason}`,
            supersedesDeliveryId: current.supersedes_delivery_id,
          });
          write(
            "UPDATE continuation_delivery SET run_id=?,state='bound',envelope=?,next_attempt_at=NULL WHERE id=?",
            run.id,
            JSON.stringify(envelope),
            current.id,
          );
        } catch {
          const attempt = current.attempt + 1,
            delay = retryDelay(attempt);
          write(
            "UPDATE continuation_delivery SET attempt=?,state=?,error_code='delivery_unavailable',next_attempt_at=? WHERE id=?",
            attempt,
            delay === null ? "attention" : "pending",
            delay === null ? null : now.getTime() + delay,
            current.id,
          );
        }
      })
      .immediate();
  }
}
export function pendingContinuations(runId: string): ContinuationInputEnvelope[] {
  return all<DeliveryRow>(
    "SELECT * FROM continuation_delivery WHERE run_id=? AND state='bound' AND admitted_at IS NULL ORDER BY created_at,id",
    runId,
  ).flatMap((row) => {
    if (!deliveryCurrent(row)) {
      cancelInvalid(row);
      return [];
    }
    return [continuationInputEnvelopeSchema.parse(JSON.parse(row.envelope!))];
  });
}
/** Third epoch gate. Persist before the synchronous transport; even a thrown write cannot authorize a resend. */
export function admitContinuation<T>(
  deliveryId: string,
  runId: string,
  now: Date,
  send: (input: ContinuationInputEnvelope) => T,
): T | undefined {
  let output: T | undefined,
    error: unknown,
    threw = false;
  sqlite
    .transaction(() => {
      const row = one<DeliveryRow>(
        "SELECT * FROM continuation_delivery WHERE id=? AND run_id=?",
        deliveryId,
        runId,
      );
      if (!row || row.state !== "bound" || row.admitted_at !== null) return;
      const run = one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", runId);
      if (run?.status !== "running" || !deliveryCurrent(row)) {
        cancelInvalid(row);
        return;
      }
      const changed = write(
        "UPDATE continuation_delivery SET state='admitted',admitted_at=?,attempt=attempt+1,error_code=NULL WHERE id=? AND state='bound' AND admitted_at IS NULL AND control_epoch=(SELECT epoch FROM chat_automation_control WHERE chat_id=? AND mode='enabled')",
        now.getTime(),
        deliveryId,
        row.chat_id,
      ).changes;
      if (!changed) return;
      try {
        output = send(continuationInputEnvelopeSchema.parse(JSON.parse(row.envelope!)));
      } catch (e) {
        threw = true;
        error = e;
        write(
          "UPDATE continuation_delivery SET state='attention',error_code='delivery_unknown' WHERE id=?",
          row.id,
        );
      }
    })
    .immediate();
  if (threw) throw error;
  return output;
}
export function acknowledgeContinuation(deliveryId: string, runId: string, now: Date) {
  write(
    "UPDATE continuation_delivery SET state='delivered',delivered_at=?,error_code=NULL WHERE id=? AND run_id=? AND state IN ('admitted','attention') AND admitted_at IS NOT NULL AND delivered_at IS NULL",
    now.getTime(),
    deliveryId,
    runId,
  );
  signalScheduleChange();
}
export function rejectContinuation(deliveryId: string, runId: string) {
  write(
    "UPDATE continuation_delivery SET state='attention',error_code='delivery_unknown' WHERE id=? AND run_id=? AND state='admitted'",
    deliveryId,
    runId,
  );
  signalScheduleChange();
}
/** Only normal completion may immediately carry unadmitted continuation inputs. */
export function settleContinuationRun(runId: string, status: string, now: Date) {
  write(
    "UPDATE continuation_delivery SET state='attention',error_code='delivery_unknown' WHERE run_id=? AND state='admitted'",
    runId,
  );
  if (status !== "completed") return;
  write(
    "UPDATE continuation_delivery SET state='pending',run_id=NULL,envelope=NULL WHERE run_id=? AND state='bound' AND admitted_at IS NULL",
    runId,
  );
  bindPendingDeliveries(now);
}
