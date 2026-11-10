import { and, eq, isNull } from "drizzle-orm";

import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  resolveLeaseTimeouts,
  type LeaseEscrowTimeout,
  type LeaseTimeouts,
} from "../contracts/lease-timeout";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  chat,
  leaseEscrow,
  machine,
  message,
  project,
} from "../db/schema";
import { appendEscrowTimeoutOwnerRunInput } from "./agent-run";
import { retryDelay } from "./chat-schedule";
import type { ProjectContext } from "./project";

type LeaseEscrowRow = typeof leaseEscrow.$inferSelect;

/**
 * 系统提醒的发送者标识。
 *
 * `message.senderKind` 只有 human / agent（info-hub 明确不引入合成 system Agent），所以超时提醒
 * 以这个保留的 sender id 落在挂靠所在 Group 的 chat 里。它是**直接写库消息**、不走 `sendMessage`，
 * 因此既不会触发唤醒评估、也不会触发自动接续——这正是 T4 要求的「提醒消息不触发唤醒」。
 * 它没有 mention span，也不进成员表，UI 会把它显示为未知发送者（见报告里的 UI 交接点）。
 */
export const LEASE_TIMEOUT_SENDER_ID = "sprout.lease-timeout";

export type LeaseTimeoutRecipient =
  | { readonly kind: "agent"; readonly agentProfileId: string }
  | { readonly kind: "human"; readonly userId: string };

/** T3：提醒对象是挂靠所在 Group 的 owner；owner 的种类决定是唤醒还是只发消息。 */
export function leaseTimeoutOwner(row: {
  ownerKind: "human" | "agent";
  ownerId: string;
}): LeaseTimeoutRecipient {
  return row.ownerKind === "agent"
    ? { kind: "agent", agentProfileId: row.ownerId }
    : { kind: "human", userId: row.ownerId };
}

/** 读默认值：项目行没配过（或写坏了）就用 `DEFAULT_LEASE_TIMEOUTS`。 */
export function projectLeaseTimeouts(projectId: string): LeaseTimeouts {
  const row = db
    .select({ wakePolicy: project.wakePolicy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  return resolveLeaseTimeouts(row?.wakePolicy?.leaseTimeouts);
}

export function projectOwnerUserId(projectId: string): string | undefined {
  return db
    .select({ createdBy: project.createdBy })
    .from(project)
    .where(eq(project.id, projectId))
    .get()?.createdBy;
}

/**
 * T9 的升级对象：挂靠发起者背后的人类 + Project owner，去重。
 * 升级只走 chat 消息（T4 的通道限制），所以这里只需要人类 id。
 */
export function leaseEscalationRecipients(row: LeaseEscrowRow): LeaseTimeoutRecipient[] {
  const initiator = db
    .select({ createdBy: agentProfile.createdBy })
    .from(agentInstance)
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .where(eq(agentInstance.id, row.escrowedByInstanceId))
    .get();
  const owner = projectOwnerUserId(row.projectId);
  const ids = new Set<string>();
  if (initiator) ids.add(initiator.createdBy);
  if (owner) ids.add(owner);
  return [...ids].map((userId) => ({ kind: "human" as const, userId }));
}

/**
 * 超时状态机。**纯函数**：只按挂靠的接受时刻、提醒/升级事实与时限算出这一刻该做什么，
 * 任何写入都由调用方按返回的步骤执行。
 *
 * T1 计时起点是 `escrowedAt`（挂靠被接受那一刻的 `lease_escrow` 创建时间），不是申请时刻。
 * T5 只提醒一次：`notifiedAt` 有值之后不再 `remind`，只可能在**唤醒投递失败**时重试投递（T8），
 * 提醒消息本身不重发。T9 升级只在 owner 是 Agent 时发生——人类 owner 收到提醒后不再升级。
 */
export type LeaseTimeoutStep =
  | { readonly kind: "pending"; readonly remindAt: Date }
  | {
      readonly kind: "remind";
      readonly owner: LeaseTimeoutRecipient;
      readonly escalateAt: Date | null;
    }
  | {
      readonly kind: "retry_remind";
      readonly owner: LeaseTimeoutRecipient;
      readonly escalateAt: Date | null;
    }
  | { readonly kind: "escalate"; readonly recipients: readonly LeaseTimeoutRecipient[] }
  | { readonly kind: "awaiting_handling" };

export function leaseTimeoutStep(input: {
  readonly escrowedAt: Date;
  readonly notifiedAt: Date | null;
  readonly escalatedAt: Date | null;
  readonly noticeNextAt: Date | null;
  readonly owner: LeaseTimeoutRecipient;
  readonly escalationRecipients: readonly LeaseTimeoutRecipient[];
  readonly timeouts: LeaseTimeouts;
  readonly now: Date;
}): LeaseTimeoutStep {
  const deadline = new Date(input.escrowedAt.getTime() + input.timeouts.timeoutMs);
  const escalateAt = new Date(deadline.getTime() + input.timeouts.escalationMs);
  if (input.escalatedAt !== null) return { kind: "awaiting_handling" };
  if (input.now.getTime() < deadline.getTime()) return { kind: "pending", remindAt: deadline };
  if (input.notifiedAt === null)
    return {
      kind: "remind",
      owner: input.owner,
      escalateAt: input.owner.kind === "agent" ? escalateAt : null,
    };
  if (input.owner.kind === "agent") {
    if (input.now.getTime() >= escalateAt.getTime())
      return { kind: "escalate", recipients: input.escalationRecipients };
    if (input.noticeNextAt !== null && input.noticeNextAt.getTime() <= input.now.getTime())
      return { kind: "retry_remind", owner: input.owner, escalateAt };
  }
  return { kind: "awaiting_handling" };
}

/**
 * T8：唤醒失败按 `src/domain/agent-run.ts` 既有的重试规则重试——这里只把
 * `chat-continuation` 的既有间隔表读出来算下一次时刻，不新造退避、次数或间隔参数。
 * 既有间隔表用尽（返回 null）就停止重试；「超时待处理」状态仍然常驻。
 */
export function leaseTimeoutRetryAt(attempt: number, now: Date): Date | null {
  const delay = retryDelay(attempt);
  return delay === null ? null : new Date(now.getTime() + delay);
}

/** 挂靠视图里的超时事实（只读，T6）。租约占用与权限不受这些字段影响。 */
export function leaseTimeoutFacts(
  row: LeaseEscrowRow,
  timeouts: LeaseTimeouts,
  now: Date,
): LeaseEscrowTimeout {
  const deadline = new Date(row.escrowedAt.getTime() + timeouts.timeoutMs);
  return {
    deadlineAt: deadline.toISOString(),
    notifiedAt: row.timeoutNotifiedAt?.toISOString() ?? null,
    escalatedAt: row.timeoutEscalatedAt?.toISOString() ?? null,
    // T5/T6：「超时待处理」常驻，直到被处理——领取、撤销、强制收回会关掉这一行，届时自然消失。
    awaitingHandling: row.state === "escrowed" && now.getTime() >= deadline.getTime(),
    ownerAutoAttemptsPaused: row.timeoutEscalatedAt !== null,
  };
}

function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${ms} 毫秒`;
}

type ReminderContext = {
  readonly machineName: string;
  readonly chatTitle: string;
  readonly initiatorName: string;
};

function reminderContext(row: LeaseEscrowRow): ReminderContext {
  const machineName =
    db.select({ name: machine.name }).from(machine).where(eq(machine.id, row.machineId)).get()
      ?.name ?? row.machineId;
  const chatRow = db.select({ title: chat.title }).from(chat).where(eq(chat.id, row.chatId)).get();
  const initiator = db
    .select({ name: agentProfile.name })
    .from(agentInstance)
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .where(eq(agentInstance.id, row.escrowedByInstanceId))
    .get();
  return {
    machineName,
    chatTitle: chatRow?.title ?? row.chatId,
    initiatorName: initiator?.name ?? row.escrowedByInstanceId,
  };
}

/**
 * T3/T4 的超时提醒正文。必须说清「要处理什么」：谁要用哪台 Machine、租约挂在哪个 Group、
 * 要 owner 决定归还还是继续占用。人类 owner 的版本额外说明这条提醒不触发唤醒、也不再升级。
 */
function reminderBody(
  context: ReminderContext,
  row: LeaseEscrowRow,
  owner: LeaseTimeoutRecipient,
  timeouts: LeaseTimeouts,
): string {
  const waited = durationText(timeouts.timeoutMs);
  const head = `【挂靠超时】${context.initiatorName} 要用 Machine「${context.machineName}」，它的租约挂在对话《${context.chatTitle}》（${row.id}）的挂靠里已经超过 ${waited}。`;
  const ask = `请处理：是让 ${context.initiatorName} 归还（撤销挂靠或强制收回），还是继续占用（领取这个挂靠）。在你处理之前，租约占用与权限保持不变。`;
  if (owner.kind === "human")
    return `${head}\n${ask}\n（这是提醒消息，不触发唤醒、也不触发自动接续；这条挂靠不会再升级，请自行决定是否处理。）`;
  return `${head}\n${ask}`;
}

function escalationBody(
  context: ReminderContext,
  row: LeaseEscrowRow,
  recipient: LeaseTimeoutRecipient,
  owner: LeaseTimeoutRecipient,
  timeouts: LeaseTimeouts,
): string {
  const who = owner.kind === "agent" ? `Agent owner ${owner.agentProfileId}` : "该 owner";
  return `【挂靠超时升级】${who} 超过 ${durationText(timeouts.timeoutMs)} 没有处理 Machine「${context.machineName}」的挂靠（发起者 ${context.initiatorName}，对话《${context.chatTitle}》，挂靠 ${row.id}），之后又过了 ${durationText(timeouts.escalationMs)} 仍未处理。
系统已暂停该 owner 在这个挂靠上的自动尝试，等人类决定：归还还是继续占用。
（升级只以这条 chat 消息告知，不触发唤醒、也不触发自动接续。${
    recipient.kind === "human" ? `收件人 ${recipient.userId}。` : ""
  }）`;
}

/** 只写 chat 消息：不经 `sendMessage`，因此不触发唤醒与自动接续（T4）。 */
function writeReminderMessage(chatId: string, body: string, now: Date): string {
  const id = newId(ID_PREFIXES.message);
  db.insert(message)
    .values({
      id,
      chatId,
      senderKind: "agent",
      senderId: LEASE_TIMEOUT_SENDER_ID,
      body,
      createdAt: now,
    })
    .run();
  return id;
}

export type LeaseTimeoutSweepResult = {
  readonly reminded: number;
  readonly rewoken: number;
  readonly escalated: number;
};

/**
 * 推进所有活跃挂靠的超时提醒与升级（T1–T10）。
 *
 * **T10 是明确例外**：这里刻意**不读** `chat_continuation_control`（「人类暂停自动唤醒」）。
 * 超时提醒与升级不受它影响，照发——不要把它当 bug 修掉。
 *
 * T6：整个函数只写 message 与 lease_escrow 的四个超时列，绝不释放租约、绝不动
 * machine_lease / lease_authorization。超时不是「自动收回」。
 */
export function sweepLeaseEscrowTimeouts(now: Date): LeaseTimeoutSweepResult {
  let reminded = 0;
  let rewoken = 0;
  let escalated = 0;
  const timeoutsByProject = new Map<string, LeaseTimeouts>();
  const rows = db.select().from(leaseEscrow).where(eq(leaseEscrow.state, "escrowed")).all();
  for (const row of rows) {
    const ownerRow = db
      .select({ ownerKind: chat.ownerKind, ownerId: chat.ownerId })
      .from(chat)
      .where(eq(chat.id, row.chatId))
      .get();
    if (!ownerRow) continue;
    let timeouts = timeoutsByProject.get(row.projectId);
    if (!timeouts) {
      timeouts = projectLeaseTimeouts(row.projectId);
      timeoutsByProject.set(row.projectId, timeouts);
    }
    const owner = leaseTimeoutOwner(ownerRow);
    const step = leaseTimeoutStep({
      escrowedAt: row.escrowedAt,
      notifiedAt: row.timeoutNotifiedAt,
      escalatedAt: row.timeoutEscalatedAt,
      noticeNextAt: row.timeoutNoticeNextAt,
      owner,
      escalationRecipients: leaseEscalationRecipients(row),
      timeouts,
      now,
    });
    if (step.kind === "pending" || step.kind === "awaiting_handling") continue;
    const context = reminderContext(row);
    if (step.kind === "remind" || step.kind === "retry_remind") {
      const first = step.kind === "remind";
      const wake = first
        ? deliverOwnerReminder(row, owner, context, timeouts, now)
        : redeliverOwnerWake(row, owner, now);
      if (wake === null) continue;
      if (first) {
        const updated = db
          .update(leaseEscrow)
          .set({
            timeoutNotifiedAt: now,
            timeoutNoticeAttempt: wake.ok ? null : 1,
            timeoutNoticeNextAt: wake.ok ? null : wake.nextAt,
          })
          .where(and(eq(leaseEscrow.id, row.id), isNull(leaseEscrow.timeoutNotifiedAt)))
          .run();
        if (updated.changes === 0) continue;
        reminded += 1;
      } else {
        db.update(leaseEscrow)
          .set({
            timeoutNoticeAttempt: wake.ok ? null : wake.attempt,
            timeoutNoticeNextAt: wake.ok ? null : wake.nextAt,
          })
          .where(eq(leaseEscrow.id, row.id))
          .run();
        rewoken += 1;
      }
      continue;
    }
    // escalate：只写 chat 消息，不触发唤醒（T9），之后停止对该 owner 的自动尝试。
    db.update(leaseEscrow)
      .set({ timeoutEscalatedAt: now, timeoutNoticeAttempt: null, timeoutNoticeNextAt: null })
      .where(and(eq(leaseEscrow.id, row.id), isNull(leaseEscrow.timeoutEscalatedAt)))
      .run();
    for (const recipient of step.recipients)
      writeReminderMessage(
        row.chatId,
        escalationBody(context, row, recipient, owner, timeouts),
        now,
      );
    escalated += 1;
  }
  return { reminded, rewoken, escalated };
}

type WakeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly attempt: number; readonly nextAt: Date | null };

/**
 * 超时提醒的投递（T3/T7/T8）：先把提醒写进 chat，agent owner 再直接唤醒。
 * 唤醒失败**保留提醒消息**（提醒只发一次）并给出按既有规则算出的下一次重试时刻。
 */
function deliverOwnerReminder(
  row: LeaseEscrowRow,
  owner: LeaseTimeoutRecipient,
  context: ReminderContext,
  timeouts: LeaseTimeouts,
  now: Date,
): WakeOutcome | null {
  const messageId = writeReminderMessage(
    row.chatId,
    reminderBody(context, row, owner, timeouts),
    now,
  );
  if (owner.kind !== "agent") return { ok: true };
  return wakeOwner(row, owner, messageId, 1, now);
}

function redeliverOwnerWake(
  row: LeaseEscrowRow,
  owner: LeaseTimeoutRecipient,
  now: Date,
): WakeOutcome | null {
  if (owner.kind !== "agent") return null;
  const reminder = db
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.chatId, row.chatId), eq(message.senderId, LEASE_TIMEOUT_SENDER_ID)))
    .orderBy(message.createdAt)
    .get();
  if (!reminder) return null;
  return wakeOwner(row, owner, reminder.id, (row.timeoutNoticeAttempt ?? 0) + 1, now);
}

function wakeOwner(
  row: LeaseEscrowRow,
  owner: Extract<LeaseTimeoutRecipient, { kind: "agent" }>,
  messageId: string,
  attempt: number,
  now: Date,
): WakeOutcome {
  // 系统以 Project owner 的人类身份派发：`ensureInstance`/`getChat` 需要一个在 Project 内的
  // 人类身份，owner 的 instance 与该人类无关，只是边界校验。
  const actingUserId = projectOwnerUserId(row.projectId);
  if (!actingUserId) return { ok: false, attempt, nextAt: leaseTimeoutRetryAt(attempt, now) };
  const ctx: ProjectContext = { userId: actingUserId, requestId: newId(ID_PREFIXES.request) };
  try {
    appendEscrowTimeoutOwnerRunInput(messageId, owner.agentProfileId, ctx);
    return { ok: true };
  } catch {
    return { ok: false, attempt, nextAt: leaseTimeoutRetryAt(attempt, now) };
  }
}

/**
 * 下一次需要被叫醒的时刻（毫秒）。调度器把它并进既有的 rearm 计算，好让提醒在截止时刻
 * 触发，而不是等 15 秒兜底心跳。返回的时刻可能是过去时刻，调用方按「已经到期」处理。
 */
export function nextLeaseTimeoutDueAt(): number | null {
  let due: number | null = null;
  const keep = (value: number | null) => {
    if (value !== null && (due === null || value < due)) due = value;
  };
  const rows = db.select().from(leaseEscrow).where(eq(leaseEscrow.state, "escrowed")).all();
  for (const row of rows) {
    const timeouts = projectLeaseTimeouts(row.projectId);
    const deadline = row.escrowedAt.getTime() + timeouts.timeoutMs;
    if (row.timeoutEscalatedAt !== null) continue;
    if (row.timeoutNotifiedAt === null) {
      keep(deadline);
      continue;
    }
    const ownerRow = db
      .select({ ownerKind: chat.ownerKind })
      .from(chat)
      .where(eq(chat.id, row.chatId))
      .get();
    if (ownerRow?.ownerKind !== "agent") continue;
    keep(deadline + timeouts.escalationMs);
    if (row.timeoutNoticeNextAt !== null) keep(row.timeoutNoticeNextAt.getTime());
  }
  return due;
}

/** 只在测试与诊断中使用：把一行挂靠的超时列复位。 */
export function resetLeaseTimeoutFacts(escrowId: string): void {
  sqlite
    .prepare(
      "UPDATE lease_escrow SET timeout_notified_at=NULL, timeout_notice_attempt=NULL, timeout_notice_next_at=NULL, timeout_escalated_at=NULL WHERE id=?",
    )
    .run(escrowId);
}
