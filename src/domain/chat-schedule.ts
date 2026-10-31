import type { WakeEvaluationInput } from "../contracts/wake-evaluation";
import { createHash, randomUUID } from "node:crypto";
import { sqlite } from "../db";
import { CHAT_AUTOMATION_POLICY as POLICY } from "../contracts/chat-automation";

export const INTERVAL_MS = POLICY.intervalSeconds * 1000;
export const CLAIM_LEASE_MS = 120_000;
export type SchedulerContext = { now: Date; requestId: string; workerId: string };
export type Control = {
  chat_id: string;
  mode: "enabled" | "paused" | "stopped";
  epoch: number;
  revision: number;
  changed_by: string | null;
  changed_at: number | null;
  reason: string | null;
};
export type Schedule = {
  chat_id: string;
  project_id: string;
  next_due_at: number | null;
  round: number;
  fingerprint: string;
  updated_at: number;
};
export type Evaluation = {
  id: string;
  project_id: string;
  chat_id: string;
  source: "task_periodic";
  round: number;
  control_epoch: number;
  fingerprint: string;
  state: string;
  attempt: number;
  claim_token: string | null;
  lease_until: number | null;
  next_attempt_at: number | null;
  input: string | null;
  result: string | null;
  error_code: string | null;
  request_id: string;
  created_at: number;
  evaluated_at: number | null;
};
export type ChatFacts = {
  id: string;
  project_id: string;
  kind: "dm" | "group" | "public_channel";
  owner_kind: "agent" | "human";
  owner_id: string;
  created_by: string;
  archived_at: number | null;
  governance_revision: number;
  wake_policy: "mention_only" | "owner_led" | "contextual";
  title: string | null;
};
export type TaskFacts = {
  id: string;
  project_id: string;
  chat_id: string;
  title: string;
  revision: number;
  assignment_revision: number;
  updated_at: number;
};
export const one = <T>(sql: string, ...params: unknown[]) =>
  sqlite.prepare(sql).get(...params) as T | undefined;
export const all = <T>(sql: string, ...params: unknown[]) =>
  sqlite.prepare(sql).all(...params) as T[];
export const write = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();
const listeners = new Set<() => void>();
/** Queue after the enclosing synchronous transaction commits. */
export function signalScheduleChange() {
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}
export function onScheduleChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function controlFor(chatId: string): Control {
  write(
    "INSERT OR IGNORE INTO chat_automation_control(chat_id) SELECT id FROM chat WHERE id=?",
    chatId,
  );
  const control = one<Control>("SELECT * FROM chat_automation_control WHERE chat_id=?", chatId);
  if (!control) throw new Error("Chat not found");
  return control;
}
export function chatFacts(chatId: string) {
  return one<ChatFacts>("SELECT * FROM chat WHERE id=?", chatId);
}
export function assignedTasks(chatId: string) {
  return all<TaskFacts>(
    "SELECT * FROM task WHERE chat_id=? AND status='assigned' ORDER BY id",
    chatId,
  );
}
export function responsibleRecipient(
  chatId: string,
): { kind: "human" | "agent"; id: string; instanceId: string | null } | null {
  const chat = chatFacts(chatId);
  if (!chat || chat.archived_at !== null) return null;
  const owner =
    chat.kind === "dm"
      ? one<{ id: string }>(
          "SELECT member_id AS id FROM chat_effective_member WHERE chat_id=? AND member_kind='agent'",
          chatId,
        )
      : { id: chat.owner_id };
  const kind = chat.kind === "dm" ? "agent" : chat.owner_kind;
  if (
    !owner ||
    !one(
      "SELECT 1 FROM chat_effective_member WHERE chat_id=? AND member_kind=? AND member_id=?",
      chatId,
      kind,
      owner.id,
    )
  )
    return null;
  if (kind === "human") return { kind, id: owner.id, instanceId: null };
  if (
    !one(
      "SELECT 1 FROM project_member WHERE project_id=? AND agent_profile_id=?",
      chat.project_id,
      owner.id,
    )
  )
    return null;
  const instance = one<{ id: string }>(
    "SELECT id FROM agent_instance WHERE chat_id=? AND agent_profile_id=?",
    chatId,
    owner.id,
  );
  return { kind, id: owner.id, instanceId: instance?.id ?? null };
}
export function ensureResponsibleInstance(chatId: string, now: Date) {
  const owner = responsibleRecipient(chatId),
    chat = chatFacts(chatId);
  if (owner?.kind === "agent" && owner.instanceId === null && chat) {
    write(
      "INSERT OR IGNORE INTO agent_instance(id,chat_id,project_id,agent_profile_id,created_at) VALUES(?,?,?,?,?)",
      `ins_${randomUUID()}`,
      chatId,
      chat.project_id,
      owner.id,
      Math.floor(now.getTime() / 1000),
    );
  }
  return responsibleRecipient(chatId);
}
/** Excludes wall time and scheduler history. Any material work/control/policy change invalidates old conclusions. */
export function currentFingerprint(chatId: string): string {
  const chat = chatFacts(chatId);
  return hash({
    chat,
    control: controlFor(chatId).epoch,
    tasks: assignedTasks(chatId).map((t) => [t.id, t.revision, t.assignment_revision]),
    policy: one("SELECT wake_policy FROM project WHERE id=?", chat?.project_id ?? ""),
    members: all(
      "SELECT member_kind,member_id FROM chat_effective_member WHERE chat_id=? ORDER BY member_kind,member_id",
      chatId,
    ),
    leases: all(
      "SELECT ml.machine_id,ml.generation,ml.state FROM machine_lease ml JOIN agent_instance ai ON ai.id=ml.holder_instance_id WHERE ai.chat_id=? ORDER BY ml.machine_id",
      chatId,
    ),
    executions: all("SELECT id,state FROM remote_execution WHERE chat_id=? ORDER BY id", chatId),
    message: one(
      "SELECT id FROM message WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      chatId,
    ),
    // The last settled run is a meaningful new fact; allocating a run is not.
    run: one(
      "SELECT id,status FROM agent_run WHERE chat_id=? AND status NOT IN ('queued','running') ORDER BY settled_at DESC,rowid DESC LIMIT 1",
      chatId,
    ),
  });
}
export type DeliveryContext = {
  chat_id: string;
  project_id: string;
  evaluation_id: string;
  recipient_kind: "human" | "agent";
  recipient_id: string;
  instance_id: string | null;
};
/** Material work facts ignore run turnover and control epoch; attempted input remains an audit fact. */
export function deliveryContextMatches(row: DeliveryContext) {
  const owner = responsibleRecipient(row.chat_id),
    chat = chatFacts(row.chat_id),
    tasks = assignedTasks(row.chat_id);
  const evaluation = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", row.evaluation_id);
  const input = evaluation?.input ? (JSON.parse(evaluation.input) as WakeEvaluationInput) : null;
  const policy = one<{ wake_policy: string | null }>(
    "SELECT wake_policy FROM project WHERE id=?",
    row.project_id,
  )?.wake_policy;
  return (
    owner?.kind === row.recipient_kind &&
    owner.id === row.recipient_id &&
    owner.instanceId === row.instance_id &&
    input !== null &&
    tasks.length > 0 &&
    tasks.length === input.tasks.length &&
    tasks.every((t) =>
      input.tasks.some(
        (old) =>
          old.id === t.id &&
          old.revision === t.revision &&
          old.assignmentRevision === t.assignment_revision,
      ),
    ) &&
    chat?.governance_revision === input.chat.governanceRevision - 1 &&
    policy !== null &&
    policy !== undefined &&
    hash(JSON.parse(policy)) === hash(input.policy)
  );
}
export function hasUnknownDeliveryBarrier(chatId: string) {
  return all<DeliveryContext>(
    "SELECT * FROM continuation_delivery WHERE chat_id=? AND state='attention' AND error_code='delivery_unknown' AND NOT EXISTS (SELECT 1 FROM continuation_delivery replacement WHERE replacement.supersedes_delivery_id=continuation_delivery.id)",
    chatId,
  ).some(deliveryContextMatches);
}
export function cancelUnadmitted(chatId: string, reason: string) {
  write(
    "UPDATE continuation_delivery SET state='canceled',cancel_reason=?,next_attempt_at=NULL WHERE chat_id=? AND state IN ('pending','bound') AND admitted_at IS NULL",
    reason,
    chatId,
  );
  write(
    "UPDATE continuation_delivery SET state='stale' WHERE chat_id=? AND state='presented'",
    chatId,
  );
}
export function reconcileChatSchedule(chatId: string, now: Date): void {
  const chat = chatFacts(chatId);
  if (!chat) return;
  const control = controlFor(chatId);
  const tasks = assignedTasks(chatId);
  const fingerprint = currentFingerprint(chatId);
  const old = one<Schedule>("SELECT * FROM chat_schedule WHERE chat_id=?", chatId);
  const invalid = control.mode !== "enabled" || chat.archived_at !== null || tasks.length === 0;
  if (invalid || (old && old.fingerprint !== fingerprint)) {
    if (invalid)
      cancelUnadmitted(
        chatId,
        control.mode === "paused"
          ? "human_paused"
          : control.mode === "stopped"
            ? "human_stopped"
            : chat.archived_at !== null
              ? "chat_archived"
              : "task_context_changed",
      );
    write(
      "UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=? AND state IN ('pending','claimed','retry_wait')",
      chatId,
    );
  }
  if (invalid) write("DELETE FROM chat_schedule WHERE chat_id=?", chatId);
  else if (!old) {
    const round = one<{ n: number }>(
      "SELECT coalesce(max(round),0) AS n FROM wake_evaluation WHERE chat_id=?",
      chatId,
    )!.n;
    write(
      "INSERT INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at) VALUES(?,?,?,?,?,?)",
      chatId,
      chat.project_id,
      now.getTime() + INTERVAL_MS,
      round,
      fingerprint,
      now.getTime(),
    );
  } else if (old.fingerprint !== fingerprint) {
    write(
      "UPDATE chat_schedule SET fingerprint=?,next_due_at=coalesce(next_due_at,?),updated_at=? WHERE chat_id=?",
      fingerprint,
      now.getTime() + INTERVAL_MS,
      now.getTime(),
      chatId,
    );
  }
}
export function scanChatSchedules(now: Date) {
  for (const { id } of all<{ id: string }>(
    "SELECT id FROM chat WHERE id IN (SELECT chat_id FROM task WHERE status='assigned') OR id IN (SELECT chat_id FROM chat_schedule)",
  ))
    reconcileChatSchedule(id, now);
}
export function evaluationCurrent(evaluation: Evaluation) {
  const control = controlFor(evaluation.chat_id);
  return (
    control.mode === "enabled" &&
    control.epoch === evaluation.control_epoch &&
    assignedTasks(evaluation.chat_id).length > 0 &&
    responsibleRecipient(evaluation.chat_id) !== null &&
    currentFingerprint(evaluation.chat_id) === evaluation.fingerprint
  );
}
/** Claim and epoch snapshot are one writer transaction. A lease never resets the attempt budget. */
export function claimDueEvaluation(ctx: SchedulerContext): Evaluation | undefined {
  return sqlite
    .transaction(() => {
      const due = one<Schedule>(
        "SELECT * FROM chat_schedule WHERE next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at,chat_id LIMIT 1",
        ctx.now.getTime(),
      );
      if (!due) return undefined;
      reconcileChatSchedule(due.chat_id, ctx.now);
      const schedule = one<Schedule>("SELECT * FROM chat_schedule WHERE chat_id=?", due.chat_id);
      if (!schedule || schedule.next_due_at === null || schedule.next_due_at > ctx.now.getTime())
        return undefined;
      const control = controlFor(due.chat_id);
      if (control.mode !== "enabled") return undefined; // First epoch gate: no provider work when disabled.
      ensureResponsibleInstance(due.chat_id, ctx.now);
      let evaluation = one<Evaluation>(
        "SELECT * FROM wake_evaluation WHERE chat_id=? AND state IN ('pending','claimed','retry_wait')",
        due.chat_id,
      );
      if (evaluation?.state === "claimed" && evaluation.lease_until! > ctx.now.getTime()) {
        write(
          "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
          evaluation.lease_until,
          due.chat_id,
        );
        return undefined;
      }
      if (evaluation && evaluation.attempt >= POLICY.maxAttempts) {
        write(
          "UPDATE wake_evaluation SET state='attention',error_code=coalesce(error_code,'provider_unavailable'),claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=?",
          evaluation.id,
        );
        write("UPDATE chat_schedule SET next_due_at=NULL WHERE chat_id=?", due.chat_id);
        return undefined;
      }
      if (!evaluation) {
        // Same-fact uncertainty/unknown delivery is a durable barrier, even after restart.
        if (
          one(
            "SELECT 1 FROM wake_evaluation WHERE chat_id=? AND fingerprint=? AND state='attention' LIMIT 1",
            due.chat_id,
            schedule.fingerprint,
          ) ||
          hasUnknownDeliveryBarrier(due.chat_id)
        ) {
          write("UPDATE chat_schedule SET next_due_at=NULL WHERE chat_id=?", due.chat_id);
          return undefined;
        }
        const id = `evaluation_${randomUUID()}`;
        write(
          "INSERT INTO wake_evaluation(id,project_id,chat_id,round,control_epoch,fingerprint,state,request_id,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
          id,
          due.project_id,
          due.chat_id,
          schedule.round + 1,
          control.epoch,
          schedule.fingerprint,
          ctx.requestId,
          ctx.now.getTime(),
        );
        for (const task of assignedTasks(due.chat_id))
          write(
            "INSERT INTO wake_evaluation_task VALUES(?,?,?,?,?)",
            id,
            task.id,
            task.project_id,
            task.revision,
            task.assignment_revision,
          );
        write("UPDATE chat_schedule SET round=round+1 WHERE chat_id=?", due.chat_id);
        evaluation = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", id)!;
      }
      const token = `${ctx.workerId}:${randomUUID()}`;
      write(
        "UPDATE wake_evaluation SET state='claimed',attempt=attempt+1,claim_token=?,lease_until=?,next_attempt_at=NULL WHERE id=?",
        token,
        ctx.now.getTime() + CLAIM_LEASE_MS,
        evaluation.id,
      );
      write(
        "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
        ctx.now.getTime() + CLAIM_LEASE_MS,
        due.chat_id,
      );
      return one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id);
    })
    .immediate();
}
export function retryDelay(attempt: number) {
  return POLICY.retryDelaySeconds[attempt - 1] === undefined
    ? null
    : POLICY.retryDelaySeconds[attempt - 1]! * 1000;
}
export function recoverSchedules(now: Date) {
  // An admitted but unacknowledged attempt has crossed the external boundary. Never enqueue it again.
  write(
    "UPDATE continuation_delivery SET state='attention',error_code='delivery_unknown',next_attempt_at=NULL WHERE state='admitted' AND delivered_at IS NULL",
  );
  write(
    "UPDATE continuation_delivery SET state='pending',run_id=NULL,envelope=NULL,next_attempt_at=? WHERE state='bound' AND run_id IN (SELECT id FROM agent_run WHERE status NOT IN ('queued','running'))",
    now.getTime() + INTERVAL_MS,
  );
  scanChatSchedules(now);
  for (const e of all<Evaluation>("SELECT * FROM wake_evaluation WHERE state='claimed'")) {
    write(
      "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
      Math.max(now.getTime(), e.lease_until!),
      e.chat_id,
    );
  }
  signalScheduleChange();
}
