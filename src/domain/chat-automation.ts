import { sqlite } from "../db";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  CHAT_AUTOMATION_ACTIONS,
  type ChatAutomationAction,
} from "../contracts/chat-automation-capabilities";
import {
  chatAutomationCommandSchema,
  chatAutomationViewSchema,
  type ChatAutomationAttemptView,
  type ChatAutomationCommand,
  type ChatAutomationErrorCode,
  type ChatAutomationView,
} from "../contracts/chat-automation";
import { getChat } from "./chat";
import type { ProjectContext } from "./access";
import { transitionAgentRun } from "./agent-run";
import {
  all,
  one,
  write,
  iso,
  deliveryContextMatches,
  currentFingerprint,
  controlFor,
  assignedTasks,
  reconcileChatSchedule,
  signalScheduleChange,
  wakeAttempts,
  type Evaluation,
  type WakeAttemptRow,
} from "./chat-schedule";
import {
  deliveryView,
  buildPeriodicInput,
  createContinuationDelivery,
  type DeliveryRow,
} from "./continuation-delivery";
import { messageWakeDue, reconcileMessageWake, retryMessageWake } from "./message-wake";
import type { WakeEvaluationResult } from "../contracts/wake-evaluation";

export class ChatAutomationError extends Error {
  constructor(
    readonly code: ChatAutomationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatAutomationError";
  }
}
type Action = ChatAutomationCommand["action"];
export type AutomationDenials = Partial<
  Record<Action, { code: ChatAutomationErrorCode; reason: string }>
>;
export type ChatAutomationData = {
  view: ChatAutomationView;
  allowedActions: ChatAutomationAction[];
  denials: AutomationDenials;
};
function access(projectId: string, chatId: string, ctx: ProjectContext) {
  const chat = getChat(chatId, ctx);
  if (chat.projectId !== projectId) throw new ChatAutomationError("not_found", "对话不存在");
  if (
    !ctx.agent &&
    !one(
      "SELECT 1 FROM chat_effective_member WHERE chat_id=? AND member_kind='human' AND member_id=?",
      chatId,
      ctx.userId,
    )
  )
    throw new ChatAutomationError("not_found", "对话不存在");
  return chat;
}
function latestEvaluation(chatId: string) {
  return one<Evaluation>(
    "SELECT * FROM wake_evaluation WHERE chat_id=? ORDER BY round DESC LIMIT 1",
    chatId,
  );
}
/** 时间线只回看有限几轮：更早的历史对「现在在干什么」没有信息量。 */
const ACTIVITY_ROUNDS = 5;

function recentEvaluations(chatId: string): Evaluation[] {
  return all<Evaluation>(
    "SELECT * FROM wake_evaluation WHERE chat_id=? ORDER BY round DESC LIMIT ?",
    chatId,
    ACTIVITY_ROUNDS,
  );
}
function attemptsByEvaluation(rows: readonly WakeAttemptRow[]): Map<string, WakeAttemptRow[]> {
  const grouped = new Map<string, WakeAttemptRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.evaluation_id);
    if (list) list.push(row);
    else grouped.set(row.evaluation_id, [row]);
  }
  return grouped;
}
function attemptView(row: WakeAttemptRow): ChatAutomationAttemptView {
  return {
    attempt: row.attempt,
    startedAt: iso(row.started_at)!,
    finishedAt: iso(row.finished_at),
    outcome: row.outcome as ChatAutomationAttemptView["outcome"],
    errorCode: row.error_code,
    usage: row.usage,
  };
}
export function getChatAutomation(
  projectId: string,
  chatId: string,
  ctx: ProjectContext,
): ChatAutomationData {
  const chat = access(projectId, chatId, ctx),
    control = controlFor(chatId),
    evaluation = latestEvaluation(chatId),
    rounds = recentEvaluations(chatId),
    attempts = attemptsByEvaluation(wakeAttempts(rounds.map((row) => row.id))),
    latestAttempts = evaluation ? (attempts.get(evaluation.id) ?? []) : [],
    latestAttempt = latestAttempts[latestAttempts.length - 1],
    finishedAttempt = [...latestAttempts].reverse().find((row) => row.finished_at !== null);
  const rows = all<DeliveryRow>(
    "SELECT * FROM continuation_delivery WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50",
    chatId,
  );
  const deliveries = rows.map(deliveryView);
  // 「活动 run」是自动接续自己派出去的 run：只认 `continuation_delivery` 上绑定的 run。
  // 群里显式点名（`fanoutHumanMessage`）直接创建的 run 不属于自动接续；Human owner 的
  // 提醒视图因此不会把别人的 run 算成自己的。db16480 起判定器可唤醒任意成员，回调到
  // owner 的 instance 会漏掉这些投递，所以按投递绑定而不是按 owner instance 过滤。
  const activeRunIds = all<{ id: string }>(
    "SELECT DISTINCT r.id FROM agent_run r JOIN continuation_delivery d ON d.run_id=r.id WHERE d.chat_id=? AND r.status IN ('queued','running') ORDER BY r.id",
    chatId,
  ).map((r) => r.id);
  const attention = rows.find(
    (d) =>
      d.state === "attention" &&
      !rows.some((replacement) => replacement.supersedes_delivery_id === d.id) &&
      deliveryContextMatches(d),
  );
  const view = chatAutomationViewSchema.parse({
    projectId,
    chatId,
    mode: control.mode,
    epoch: control.epoch,
    revision: control.revision,
    owner: chat.owner,
    changedBy: control.changed_by,
    changedAt: iso(control.changed_at),
    reason: control.reason,
    assignedTaskIds: assignedTasks(chatId).map((t) => t.id),
    nextDueAt:
      control.mode === "enabled"
        ? iso(
            [
              one<{ next_due_at: number | null }>(
                "SELECT next_due_at FROM chat_schedule WHERE chat_id=?",
                chatId,
              )?.next_due_at ?? null,
              messageWakeDue(chatId),
            ]
              .filter((value): value is number => value !== null)
              .sort((a, b) => a - b)[0] ?? null,
          )
        : null,
    activeRunIds,
    remindedHuman: deliveries.some(
      (d) =>
        d.recipient.kind === "human" && d.recipient.id === chat.owner.id && d.state === "presented",
    ),
    latestEvaluation: evaluation
      ? {
          evaluationId: evaluation.id,
          source: evaluation.source,
          state: evaluation.state,
          round: evaluation.round,
          attempt: evaluation.attempt,
          claimedAt: evaluation.state === "claimed" ? iso(latestAttempt?.started_at ?? null) : null,
          finishedAt: iso(finishedAttempt?.finished_at ?? null),
          evaluatedAt: iso(evaluation.evaluated_at),
          nextAttemptAt: iso(evaluation.next_attempt_at),
          result: evaluation.result ? JSON.parse(evaluation.result) : null,
          errorCode: evaluation.error_code,
          usage: latestAttempt?.usage ?? null,
        }
      : null,
    recentRounds: rounds.map((row) => ({
      round: row.round,
      source: row.source,
      state: row.state,
      evaluatedAt: iso(row.evaluated_at),
      result: row.result ? JSON.parse(row.result) : null,
      errorCode: row.error_code,
      attempts: (attempts.get(row.id) ?? []).map(attemptView),
    })),
    deliveries,
    attention: attention
      ? {
          errorCode: attention.error_code!,
          reason:
            attention.error_code === "delivery_unknown"
              ? "已尝试送达，是否收到未知；请核对后再重新接续。"
              : "自动接续需要处理。",
          requestId: one<Evaluation>(
            "SELECT * FROM wake_evaluation WHERE id=?",
            attention.evaluation_id,
          )!.request_id,
          evaluationId: attention.evaluation_id,
          deliveryId: attention.id,
        }
      : evaluation?.state === "attention"
        ? {
            errorCode: evaluation.error_code!,
            reason: "本轮无法判定，等待处理。",
            requestId: evaluation.request_id,
            evaluationId: evaluation.id,
            deliveryId: null,
          }
        : null,
  });
  const denials: AutomationDenials = {};
  for (const action of ["disable", "enable", "abort", "retry", "reissue"] as const) {
    if (ctx.agent) denials[action] = { code: "forbidden", reason: "自动接续控制仅供 Human 操作。" };
    else if (action === "disable" && control.mode !== "enabled")
      denials[action] = { code: "conflict", reason: "自动接续已关闭，请明确开启后再调整。" };
    else if (action === "enable" && control.mode === "enabled")
      denials[action] = { code: "conflict", reason: "自动接续已开启。" };
    else if ((action === "retry" || action === "reissue") && control.mode !== "enabled")
      denials[action] = { code: "automation_disabled", reason: "请先开启自动接续。" };
    else if (
      action === "retry" &&
      (!evaluation || !["attention", "retry_wait"].includes(evaluation.state))
    )
      denials[action] = { code: "conflict", reason: "当前没有可重试的失败检查。" };
    else if (
      action === "reissue" &&
      !rows.some(
        (d) =>
          d.error_code === "delivery_unknown" &&
          d.state === "attention" &&
          !rows.some((replacement) => replacement.supersedes_delivery_id === d.id) &&
          deliveryContextMatches(d),
      )
    )
      denials[action] = { code: "conflict", reason: "当前没有需核对的未知投递。" };
  }
  const map: Record<Action, ChatAutomationAction> = {
    disable: "chat.automation.disable",
    enable: "chat.automation.enable",
    abort: "chat.automation.abort",
    retry: "chat.automation.retry",
    reissue: "chat.automation.reissue",
  };
  const allowedActions = CHAT_AUTOMATION_ACTIONS.filter(
    (a) =>
      a === "chat.automation.read" ||
      Object.entries(map).some(
        ([action, capability]) => a === capability && !denials[action as Action],
      ),
  );
  return { view, denials, allowedActions };
}
/** Abort intention commits before host abort and never changes the Chat's control mode or epoch. */
export function persistAutomationRunStop(
  chatId: string,
  runIds: readonly string[],
  ctx: ProjectContext,
  now: Date,
) {
  if (ctx.agent) throw new ChatAutomationError("forbidden", "只有 Human 可以停止运行。");
  const current = getChat(chatId, ctx);
  access(current.projectId, chatId, ctx);
  for (const id of runIds)
    write(
      "INSERT OR IGNORE INTO chat_automation_abort(run_id,chat_id,requested_at) SELECT id,chat_id,? FROM agent_run WHERE id=? AND chat_id=? AND status IN ('queued','running')",
      now.getTime(),
      id,
      chatId,
    );
  signalScheduleChange(chatId);
}
export function applyChatAutomationCommand(
  raw: unknown,
  ctx: ProjectContext,
  now: Date,
): ChatAutomationData {
  const command = chatAutomationCommandSchema.parse(raw);
  return sqlite
    .transaction(() => {
      access(command.projectId, command.chatId, ctx);
      if (ctx.agent) throw new ChatAutomationError("forbidden", "自动接续控制仅供 Human 操作。");
      const payload = JSON.stringify({ actor: ctx.userId, command });
      const previous = one<{ payload: string; result: string }>(
        "SELECT payload,result FROM chat_automation_command WHERE request_id=?",
        command.requestId,
      );
      if (previous) {
        if (previous.payload !== payload)
          throw new ChatAutomationError("conflict", "请求标识已用于其他操作。");
        return JSON.parse(previous.result) as ChatAutomationData;
      }
      const c = controlFor(command.chatId);
      if (c.revision !== command.expectedRevision)
        throw new ChatAutomationError("conflict", "自动接续版本已变化，请刷新后重试。");
      const data = getChatAutomation(command.projectId, command.chatId, ctx),
        denial = data.denials[command.action];
      if (denial) throw new ChatAutomationError(denial.code, denial.reason);
      if (
        command.action === "disable" ||
        command.action === "enable" ||
        command.action === "abort"
      ) {
        if (
          command.action === "abort" &&
          command.runId !== undefined &&
          !one(
            "SELECT 1 FROM agent_run WHERE id=? AND chat_id=? AND status IN ('queued','running')",
            command.runId,
            command.chatId,
          )
        )
          throw new ChatAutomationError("not_found", "运行不存在。");
        if (command.action === "abort" && command.runId !== undefined) {
          // Stopping one run must leave the Chat's continuation switch and epoch intact.
          write(
            "UPDATE chat_automation_control SET revision=revision+1 WHERE chat_id=?",
            command.chatId,
          );
        } else {
          if (command.action === "abort")
            write(
              "UPDATE continuation_delivery SET state='canceled',cancel_reason='human_aborted',next_attempt_at=NULL WHERE chat_id=? AND state IN ('pending','bound') AND admitted_at IS NULL",
              command.chatId,
            );
          write(
            "UPDATE chat_automation_control SET mode=?,epoch=epoch+1,revision=revision+1,changed_by=?,changed_at=?,reason=? WHERE chat_id=? AND revision=?",
            command.action === "enable" ? "enabled" : "off",
            ctx.userId,
            now.getTime(),
            command.reason ?? null,
            command.chatId,
            command.expectedRevision,
          );
        }
        if (command.action === "abort") {
          const ids =
            command.runId !== undefined
              ? [command.runId]
              : all<{ id: string }>(
                  "SELECT id FROM agent_run WHERE chat_id=? AND status IN ('queued','running')",
                  command.chatId,
                ).map((run) => run.id);
          persistAutomationRunStop(command.chatId, ids, ctx, now);
          for (const id of ids) transitionAgentRun(id, "aborted", { stopReason: "aborted" }, ctx);
        }
        reconcileChatSchedule(command.chatId, now);
        reconcileMessageWake(command.chatId, now);
      } else if (command.action === "retry") {
        const e = one<Evaluation>(
          "SELECT * FROM wake_evaluation WHERE id=? AND chat_id=?",
          command.evaluationId,
          command.chatId,
        );
        if (!e || !["attention", "retry_wait"].includes(e.state))
          throw new ChatAutomationError("conflict", "检查不能重试。");
        write(
          "UPDATE wake_evaluation SET state='canceled',claim_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=?",
          e.id,
        );
        // Human retry explicitly opens a new budget; original history is immutable.
        if (e.source === "message") {
          if (!retryMessageWake(e, now))
            throw new ChatAutomationError("conflict", "当前没有可重试的消息判定。");
        } else
          write(
            "UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?",
            now.getTime(),
            command.chatId,
          );
        write(
          "UPDATE chat_automation_control SET revision=revision+1 WHERE chat_id=?",
          command.chatId,
        );
      } else if (command.action === "reissue") {
        const old = one<DeliveryRow>(
          "SELECT * FROM continuation_delivery WHERE id=? AND chat_id=?",
          command.deliveryId,
          command.chatId,
        );
        if (!old || old.error_code !== "delivery_unknown" || old.admitted_at === null)
          throw new ChatAutomationError("conflict", "只有未知的已尝试投递可重新接续。");
        if (one("SELECT 1 FROM continuation_delivery WHERE supersedes_delivery_id=?", old.id))
          throw new ChatAutomationError("conflict", "这条未知投递已经重新接续。");
        const evaluation = one<Evaluation>(
          "SELECT * FROM wake_evaluation WHERE id=?",
          old.evaluation_id,
        )!;
        if (evaluation.source === "message")
          throw new ChatAutomationError("conflict", "这条投递来自群消息，请让成员重新发言触发。");
        const result = JSON.parse(evaluation.result!) as WakeEvaluationResult;
        if (!deliveryContextMatches(old))
          throw new ChatAutomationError("conflict", "Task 或负责人已变化，请从当前事实重新检查。");
        const id = newId(ID_PREFIXES.wakeEvaluation);
        const round = one<{ n: number }>(
          "SELECT max(round)+1 AS n FROM wake_evaluation WHERE chat_id=?",
          command.chatId,
        )!.n;
        const freshFacts = {
          ...evaluation,
          id,
          round,
          control_epoch: c.epoch,
          fingerprint: currentFingerprint(command.chatId),
        };
        const input = buildPeriodicInput(freshFacts, now);
        const freshResult = { ...result, snapshotHash: input.snapshotHash };
        write(
          "INSERT INTO wake_evaluation(id,project_id,chat_id,round,control_epoch,fingerprint,state,attempt,input,result,request_id,created_at,evaluated_at) VALUES(?,?,?,?,?,?,'decided',0,?,?,?,?,?)",
          id,
          old.project_id,
          old.chat_id,
          round,
          c.epoch,
          freshFacts.fingerprint,
          JSON.stringify(input),
          JSON.stringify(freshResult),
          command.requestId,
          now.getTime(),
          now.getTime(),
        );
        for (const t of input.tasks)
          write(
            "INSERT INTO wake_evaluation_task VALUES(?,?,?,?,?)",
            id,
            t.id,
            old.project_id,
            t.revision,
            t.assignmentRevision,
          );
        const fresh = one<Evaluation>("SELECT * FROM wake_evaluation WHERE id=?", id)!;
        if (createContinuationDelivery(fresh, input, freshResult, now, old.id).length === 0)
          throw new ChatAutomationError("conflict", "Task 或负责人已变化，请从当前事实重新检查。");
        write("UPDATE chat_schedule SET round=? WHERE chat_id=?", round, command.chatId);
        write(
          "UPDATE chat_automation_control SET revision=revision+1 WHERE chat_id=?",
          command.chatId,
        );
      }
      const result = getChatAutomation(command.projectId, command.chatId, ctx);
      write(
        "INSERT INTO chat_automation_command VALUES(?,?,?,?,?)",
        command.requestId,
        command.chatId,
        payload,
        JSON.stringify(result),
        now.getTime(),
      );
      signalScheduleChange(command.chatId);
      return result;
    })
    .immediate();
}
export function drainAutomationAborts(now: Date, abort: (runId: string) => boolean) {
  for (const row of all<{ run_id: string }>(
    "SELECT run_id FROM chat_automation_abort WHERE signaled_at IS NULL",
  )) {
    const run = one<{ status: string }>("SELECT status FROM agent_run WHERE id=?", row.run_id);
    const signaled = abort(row.run_id);
    if (signaled || !run || !["queued", "running"].includes(run.status))
      write(
        "UPDATE chat_automation_abort SET signaled_at=? WHERE run_id=?",
        now.getTime(),
        row.run_id,
      );
  }
}
