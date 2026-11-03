import type { WakeEvaluationInput, WakeUsage } from "../contracts/wake-evaluation";
import { createHash, randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { sqlite } from "../db";
import { publishChatAutomationChange } from "./change-feed";
import { CHAT_AUTOMATION_POLICY as POLICY } from "../contracts/chat-automation";
import { DEFAULT_PROJECT_WAKE_POLICY } from "../contracts/project-wake-policy";

export const INTERVAL_MS = POLICY.intervalSeconds * 1000;
export const CLAIM_LEASE_MS = 120_000;
export type SchedulerContext = { now: Date; requestId: string; workerId: string };
export type Control = {
  chat_id: string;
  mode: "enabled" | "off";
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
  source: "message" | "task_periodic";
  trigger_message_id: string | null;
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

/**
 * 一次判定的结局。进行中的尝试没有结局，行上 `finished_at` 与 `outcome` 一起为空。
 */
export type WakeAttemptOutcome = "decided" | "retry_wait" | "attention" | "stale" | "canceled";
export type WakeAttemptRow = {
  evaluation_id: string;
  attempt: number;
  started_at: number;
  finished_at: number | null;
  outcome: string | null;
  error_code: string | null;
  usage: WakeUsage | null;
};

/**
 * 发出外部请求这一步就是尝试的开始：事后补记录不了真实的等待时长，页面就会撒谎。
 * 与 claim 同一个写者事务，所以不存在落了 claim 却没有尝试行的时间窗。
 */
export function beginWakeAttempt(evaluationId: string, attempt: number, now: Date): void {
  // 同一编号重开就是这次 claim 从头计时；已经结束的行保持原样，晚到的重开不能抹掉结局。
  write(
    "INSERT INTO wake_evaluation_attempt(evaluation_id,attempt,started_at) VALUES(?,?,?) ON CONFLICT(evaluation_id,attempt) DO UPDATE SET started_at=excluded.started_at WHERE wake_evaluation_attempt.finished_at IS NULL",
    evaluationId,
    attempt,
    now.getTime(),
  );
  // 更早的编号若因进程退出没来得及收尾，新的 claim 就是它们的结局：按中断结掉，不留永远进行中的行。
  write(
    "UPDATE wake_evaluation_attempt SET finished_at=?,outcome='stale' WHERE evaluation_id=? AND finished_at IS NULL AND attempt<>?",
    now.getTime(),
    evaluationId,
    attempt,
  );
}
/**
 * 结束一次尝试。已结束的行不再改写：先到的结局才算数，晚到的调用只能确认它。
 */
export function finishWakeAttempt(
  evaluationId: string,
  attempt: number,
  now: Date,
  outcome: WakeAttemptOutcome,
  errorCode: string | null = null,
  usage: WakeUsage | null = null,
): void {
  write(
    "UPDATE wake_evaluation_attempt SET finished_at=?,outcome=?,error_code=?,usage=? WHERE evaluation_id=? AND attempt=? AND finished_at IS NULL",
    now.getTime(),
    outcome,
    errorCode,
    usage === null ? null : JSON.stringify(usage),
    evaluationId,
    attempt,
  );
}
/**
 * 判定被外部收尾（关闭自动接续、上下文变了、消息被后一条取代）时，没结束的尝试一并结束，
 * 否则界面停在一个永远不会完成的「正在检查」。
 */
export function closeAttemptsForEvaluation(
  evaluationId: string,
  now: Date,
  outcome: WakeAttemptOutcome,
): void {
  write(
    "UPDATE wake_evaluation_attempt SET finished_at=?,outcome=? WHERE evaluation_id=? AND finished_at IS NULL",
    now.getTime(),
    outcome,
    evaluationId,
  );
}
/** 调用方先收尾尝试，再把判定改成 stale：改完之后这行已不在活动状态集合里。 */
export function closeAttemptsForChat(
  chatId: string,
  now: Date,
  outcome: WakeAttemptOutcome,
  source?: "message" | "task_periodic",
): void {
  write(
    `UPDATE wake_evaluation_attempt SET finished_at=?,outcome=? WHERE finished_at IS NULL AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE chat_id=? AND state IN ('pending','claimed','retry_wait')${source ? " AND source=?" : ""})`,
    ...(source ? [now.getTime(), outcome, chatId, source] : [now.getTime(), outcome, chatId]),
  );
}
export function wakeAttempts(evaluationIds: readonly string[]): WakeAttemptRow[] {
  if (!evaluationIds.length) return [];
  return all<Omit<WakeAttemptRow, "usage"> & { usage: string | null }>(
    `SELECT * FROM wake_evaluation_attempt WHERE evaluation_id IN (${evaluationIds.map(() => "?").join(",")}) ORDER BY attempt`,
    ...evaluationIds,
  ).map((row) => ({
    ...row,
    usage: row.usage ? (JSON.parse(row.usage) as WakeUsage) : null,
  }));
}
const listeners = new Set<() => void>();
/**
 * 队列到外层同步事务提交之后。写入点知道 chatId 时一并给出：浏览器靠这条推送重读项目与对话，
 * 不然判定早已落库、页面还在等下一次兜底轮询。
 */
export function signalScheduleChange(chatId?: string) {
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
  if (chatId) publishChatAutomationChange(chatId);
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
/** One round counter per chat; message and task_periodic evaluations share it. */
export function nextEvaluationRound(chatId: string): number {
  const schedule = one<{ round: number }>(
    "SELECT round FROM chat_schedule WHERE chat_id=?",
    chatId,
  );
  const latest = one<{ n: number }>(
    "SELECT coalesce(max(round),0) AS n FROM wake_evaluation WHERE chat_id=?",
    chatId,
  )!.n;
  return Math.max(schedule?.round ?? 0, latest) + 1;
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
export function ensureAgentInstance(
  chatId: string,
  projectId: string,
  agentProfileId: string,
  now: Date,
): string {
  const existing = one<{ id: string }>(
    "SELECT id FROM agent_instance WHERE chat_id=? AND project_id=? AND agent_profile_id=?",
    chatId,
    projectId,
    agentProfileId,
  );
  if (existing) return existing.id;
  const id = newId(ID_PREFIXES.instance);
  write(
    "INSERT OR IGNORE INTO agent_instance(id,chat_id,project_id,agent_profile_id,created_at) VALUES(?,?,?,?,?)",
    id,
    chatId,
    projectId,
    agentProfileId,
    Math.floor(now.getTime() / 1000),
  );
  return (
    one<{ id: string }>(
      "SELECT id FROM agent_instance WHERE chat_id=? AND project_id=? AND agent_profile_id=?",
      chatId,
      projectId,
      agentProfileId,
    )?.id ?? id
  );
}
export function ensureResponsibleInstance(chatId: string, now: Date) {
  const owner = responsibleRecipient(chatId),
    chat = chatFacts(chatId);
  if (owner?.kind === "agent" && owner.instanceId === null && chat) {
    write(
      "INSERT OR IGNORE INTO agent_instance(id,chat_id,project_id,agent_profile_id,created_at) VALUES(?,?,?,?,?)",
      newId(ID_PREFIXES.instance),
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
export function messageFingerprint(chatId: string, triggerMessageId: string): string {
  const chat = chatFacts(chatId);
  return hash({
    chat: chat
      ? {
          id: chat.id,
          project_id: chat.project_id,
          kind: chat.kind,
          owner_kind: chat.owner_kind,
          owner_id: chat.owner_id,
          archived_at: chat.archived_at,
          governance_revision: chat.governance_revision,
          wake_policy: chat.wake_policy,
        }
      : null,
    control: controlFor(chatId).epoch,
    policy: one("SELECT wake_policy FROM project WHERE id=?", chat?.project_id ?? ""),
    members: all(
      "SELECT member_kind,member_id FROM chat_effective_member WHERE chat_id=? AND member_kind='agent' ORDER BY member_id",
      chatId,
    ),
    trigger: one(
      "SELECT id,sender_kind,sender_id,body,created_at FROM message WHERE id=? AND chat_id=?",
      triggerMessageId,
      chatId,
    ),
    mentions: all(
      "SELECT member_kind,member_id,start,end FROM message_mention WHERE chat_id=? AND message_id=? ORDER BY start",
      chatId,
      triggerMessageId,
    ),
  });
}
export function messageEvaluationCurrent(evaluation: Evaluation): boolean {
  if (evaluation.source !== "message" || !evaluation.trigger_message_id) return false;
  const control = controlFor(evaluation.chat_id);
  const chat = chatFacts(evaluation.chat_id);
  return (
    control.mode === "enabled" &&
    control.epoch === evaluation.control_epoch &&
    chat !== undefined &&
    chat.archived_at === null &&
    chat.kind !== "dm" &&
    chat.wake_policy === "contextual" &&
    messageFingerprint(evaluation.chat_id, evaluation.trigger_message_id) === evaluation.fingerprint
  );
}
export function messageDeliveryContextMatches(
  row: DeliveryContext,
  evaluation: Evaluation,
): boolean {
  if (!messageEvaluationCurrent(evaluation) || row.recipient_kind !== "agent") return false;
  if (
    !one(
      "SELECT 1 FROM chat_effective_member WHERE chat_id=? AND project_id=? AND member_kind='agent' AND member_id=?",
      row.chat_id,
      row.project_id,
      row.recipient_id,
    )
  )
    return false;
  return !!one(
    "SELECT 1 FROM agent_instance WHERE id=? AND chat_id=? AND project_id=? AND agent_profile_id=?",
    row.instance_id,
    row.chat_id,
    row.project_id,
    row.recipient_id,
  );
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
  const evaluation = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", row.evaluation_id);
  if (evaluation?.source === "message") return messageDeliveryContextMatches(row, evaluation);
  const owner = responsibleRecipient(row.chat_id),
    chat = chatFacts(row.chat_id),
    tasks = assignedTasks(row.chat_id);
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
    policy !== undefined &&
    hash(policy === null ? DEFAULT_PROJECT_WAKE_POLICY : JSON.parse(policy)) === hash(input.policy)
  );
}
export function hasUnknownDeliveryBarrier(
  chatId: string,
  recipient?: { kind: "human" | "agent"; id: string },
) {
  const rows = recipient
    ? all<DeliveryContext>(
        "SELECT * FROM continuation_delivery WHERE chat_id=? AND recipient_kind=? AND recipient_id=? AND state='attention' AND error_code='delivery_unknown' AND NOT EXISTS (SELECT 1 FROM continuation_delivery replacement WHERE replacement.supersedes_delivery_id=continuation_delivery.id)",
        chatId,
        recipient.kind,
        recipient.id,
      )
    : all<DeliveryContext>(
        "SELECT * FROM continuation_delivery WHERE chat_id=? AND state='attention' AND error_code='delivery_unknown' AND NOT EXISTS (SELECT 1 FROM continuation_delivery replacement WHERE replacement.supersedes_delivery_id=continuation_delivery.id)",
        chatId,
      );
  return rows.some(deliveryContextMatches);
}
export function cancelUnadmitted(
  chatId: string,
  reason: string,
  source?: "message" | "task_periodic",
) {
  write(
    `UPDATE continuation_delivery SET state='canceled',cancel_reason=?,next_attempt_at=NULL WHERE chat_id=? AND state IN ('pending','bound') AND admitted_at IS NULL${source ? " AND evaluation_id IN (SELECT id FROM wake_evaluation WHERE source=?)" : ""}`,
    ...(source ? [reason, chatId, source] : [reason, chatId]),
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
        control.mode === "off"
          ? "human_disabled"
          : chat.archived_at !== null
            ? "chat_archived"
            : "task_context_changed",
        tasks.length === 0 && control.mode === "enabled" && chat.archived_at === null
          ? "task_periodic"
          : undefined,
      );
    closeAttemptsForChat(
      chatId,
      now,
      "stale",
      control.mode !== "enabled" || chat.archived_at !== null ? undefined : "task_periodic",
    );
    write(
      `UPDATE wake_evaluation SET state='stale',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE chat_id=?${control.mode !== "enabled" || chat.archived_at !== null ? "" : " AND source='task_periodic'"} AND state IN ('pending','claimed','retry_wait')`,
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
  if (evaluation.source === "message") return messageEvaluationCurrent(evaluation);
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
  const claimed = sqlite
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
      // A message evaluation owns the active slot. Yield to its scheduler instead of
      // claiming it as a task evaluation or starving it behind this schedule.
      const messageEvaluation = one<Evaluation>(
        "SELECT * FROM wake_evaluation WHERE chat_id=? AND source='message' AND state IN ('pending','claimed','retry_wait')",
        due.chat_id,
      );
      if (messageEvaluation) {
        write(
          "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
          Math.max(
            ctx.now.getTime() + 1_000,
            messageEvaluation.lease_until ?? 0,
            messageEvaluation.next_attempt_at ?? 0,
          ),
          due.chat_id,
        );
        return undefined;
      }
      let evaluation = one<Evaluation>(
        "SELECT * FROM wake_evaluation WHERE chat_id=? AND source='task_periodic' AND state IN ('pending','claimed','retry_wait')",
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
        closeAttemptsForEvaluation(evaluation.id, ctx.now, "attention");
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
        const id = newId(ID_PREFIXES.wakeEvaluation);
        const round = nextEvaluationRound(due.chat_id);
        write(
          "INSERT INTO wake_evaluation(id,project_id,chat_id,round,control_epoch,fingerprint,state,request_id,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
          id,
          due.project_id,
          due.chat_id,
          round,
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
        write("UPDATE chat_schedule SET round=? WHERE chat_id=?", round, due.chat_id);
        evaluation = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", id)!;
      }
      const token = `${ctx.workerId}:${randomUUID()}`;
      write(
        "UPDATE wake_evaluation SET state='claimed',attempt=attempt+1,claim_token=?,lease_until=?,next_attempt_at=NULL WHERE id=?",
        token,
        ctx.now.getTime() + CLAIM_LEASE_MS,
        evaluation.id,
      );
      beginWakeAttempt(evaluation.id, evaluation.attempt + 1, ctx.now);
      write(
        "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
        ctx.now.getTime() + CLAIM_LEASE_MS,
        due.chat_id,
      );
      return one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", evaluation.id);
    })
    .immediate();
  // The claim is the moment the page has something new to show: publish before the provider
  // call so "checking" appears at once instead of arriving together with the verdict.
  if (claimed) signalScheduleChange(claimed.chat_id);
  return claimed;
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
  // Bound but unadmitted input never crossed the transport boundary. Retry it on the
  // same progressive schedule; after the budget is exhausted the delivery needs attention.
  for (const row of all<{ id: string; attempt: number }>(
    "SELECT id,attempt FROM continuation_delivery WHERE state='bound' AND run_id IN (SELECT id FROM agent_run WHERE status NOT IN ('queued','running'))",
  )) {
    const attempt = row.attempt + 1;
    const delay = retryDelay(attempt);
    write(
      "UPDATE continuation_delivery SET attempt=?,state=?,run_id=NULL,envelope=NULL,next_attempt_at=?,error_code='delivery_unavailable' WHERE id=? AND state='bound'",
      attempt,
      delay === null ? "attention" : "pending",
      delay === null ? null : now.getTime() + delay,
      row.id,
    );
  }
  scanChatSchedules(now);
  for (const e of all<Evaluation>("SELECT * FROM wake_evaluation WHERE state='claimed'")) {
    if (e.source === "message")
      write(
        "UPDATE chat_message_wake SET due_at=? WHERE chat_id=? AND evaluation_id=?",
        Math.max(now.getTime(), e.lease_until!),
        e.chat_id,
        e.id,
      );
    else
      write(
        "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
        Math.max(now.getTime(), e.lease_until!),
        e.chat_id,
      );
  }
  signalScheduleChange();
}
