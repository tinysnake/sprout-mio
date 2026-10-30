import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { LeaseKey } from "../contracts/lease";
import type {
  NoticeRevocation,
  RunResourceNotice,
  RunResourceNoticeKind,
  RunResourceNoticePayload,
} from "../contracts/notice";
import { runResourceNoticeSchema } from "../contracts/notice";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db } from "../db";
import { agentRun, leaseAuthorization, project, runResourceNotice } from "../db/schema";
import { REMOTE_EXECUTION_STATES } from "../contracts/remote";
import { LeaseError } from "./lease";

/** 一条通知最多登记受影响的执行；超出就整笔拒绝，不用截断冒充完整事实。 */
export const NOTICE_EXECUTION_LIMIT = 256;

export type NoticeTx = Pick<typeof db, "select" | "insert">;

export interface RevokedExecution {
  executionId: string;
  runId: string;
  state: (typeof REMOTE_EXECUTION_STATES)[number];
}

/**
 * 通知落库的输入。`executions` 与 `holderInstanceId` 由调用方在同一事务内、撤权写入之前快照，
 * 撤权之后行的状态已被改写，再读就不再是「受影响在途执行」的事实。
 */
export interface RevokeNoticeInput {
  key: LeaseKey;
  kind: RunResourceNoticeKind;
  causeId: string;
  /** 本次撤权所依据的租约代次；0 只出现在从未建立租约的移出。 */
  generation: number;
  revocation: NoticeRevocation;
  executions: RevokedExecution[];
  holderInstanceId: string | null;
  targetInstanceId?: string | null;
  membershipEpoch?: number;
  now: Date;
}

const KIND_LABELS: Record<RunResourceNoticeKind, string> = {
  lease_handed_off: "租约已交接给其他分身",
  lease_released: "租约已释放",
  lease_reclaimed: "租约已被收回",
  machine_removed: "Machine 已从本 Project 移出",
};

/**
 * 投递文本只由已落库的通知事实构成，不含时间与调用方状态。
 * 崩溃后重投同一 noticeId 必须得到逐字相同的文本。
 */
export function noticeDeliveryText(notice: RunResourceNotice): string {
  const affected = notice.payload.executions.length
    ? notice.payload.executions
        .map((execution) => `${execution.executionId}（${execution.lastKnownState}）`)
        .join("、")
    : "无";
  return [
    `资源撤销通知 ${notice.id}：${KIND_LABELS[notice.kind]}。`,
    `Machine ${notice.machineId}，租约代次 ${notice.payload.generation}。`,
    `受影响的执行：${affected}。`,
    "本次通知不自动停止当前 run，也不清理进程或文件；请自行决定换 Machine、继续其他工作或结束。",
  ].join("");
}

function noticeView(row: typeof runResourceNotice.$inferSelect): RunResourceNotice {
  return runResourceNoticeSchema.parse({
    id: row.id,
    projectId: row.projectId,
    machineId: row.machineId,
    runId: row.runId,
    instanceId: row.instanceId,
    chatId: row.chatId,
    kind: row.kind,
    causeId: row.causeId,
    payload: row.payloadJson,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  });
}

function uniqueExecutions(executions: readonly RevokedExecution[]): RevokedExecution[] {
  const seen = new Map<string, RevokedExecution>();
  for (const execution of executions)
    if (!seen.has(execution.executionId)) seen.set(execution.executionId, { ...execution });
  return [...seen.values()];
}

function revokedGenerationHolder(tx: NoticeTx, input: RevokeNoticeInput): string | null {
  if (input.holderInstanceId) return input.holderInstanceId;
  if (input.generation === 0) return null;
  const authorization = tx
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, input.key.projectId),
        eq(leaseAuthorization.machineId, input.key.machineId),
        eq(leaseAuthorization.generation, input.generation),
      ),
    )
    .get();
  return authorization?.holderInstanceId ?? null;
}

type Recipient = { id: string; instanceId: string; chatId: string };

/**
 * 收件集合：本 Project 内旧 holder 的 queued/running runs，加上本 scope 受影响在途执行关联的
 * queued/running runs，按 runId 去重；新 holder 不收到「你失去资源」。
 */
function recipients(tx: NoticeTx, input: RevokeNoticeInput, holder: string | null): Recipient[] {
  const conditions = [];
  if (holder) conditions.push(eq(agentRun.instanceId, holder));
  const executionRunIds = [...new Set(input.executions.map((execution) => execution.runId))];
  if (executionRunIds.length) conditions.push(inArray(agentRun.id, executionRunIds));
  if (!conditions.length) return [];
  const rows = tx
    .select({ id: agentRun.id, instanceId: agentRun.instanceId, chatId: agentRun.chatId })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.projectId, input.key.projectId),
        inArray(agentRun.status, ["queued", "running"] as const),
        or(...conditions),
      ),
    )
    .orderBy(asc(agentRun.id))
    .all();
  const deduped = new Map<string, Recipient>();
  for (const row of rows)
    if (!input.targetInstanceId || row.instanceId !== input.targetInstanceId)
      deduped.set(row.id, row);
  return [...deduped.values()];
}

/**
 * 在撤权或强制收回的同一事务内落通知行。唯一索引 `(kind,cause_id,run_id)` 保证同一根因
 * 对同一 run 只有一条事实：重试、force override 与重复 ack 都不会叠加第二条。
 */
export function insertRevokeNotice(tx: NoticeTx, input: RevokeNoticeInput): RunResourceNotice[] {
  const executions = uniqueExecutions(input.executions);
  if (executions.length > NOTICE_EXECUTION_LIMIT)
    throw new LeaseError("conflict", "受影响的执行超出单条通知的事实上界");
  const holder = revokedGenerationHolder(tx, input);
  const payload: RunResourceNoticePayload = {
    kind: input.kind,
    machineId: input.key.machineId,
    generation: input.generation,
    executions: executions.map((execution) => ({
      executionId: execution.executionId,
      lastKnownState: execution.state,
    })),
    revocation: input.revocation,
    ...(input.targetInstanceId ? { targetInstanceId: input.targetInstanceId } : {}),
    ...(input.membershipEpoch === undefined ? {} : { membershipEpoch: input.membershipEpoch }),
  };
  const inserted: RunResourceNotice[] = [];
  for (const recipient of recipients(tx, input, holder)) {
    const id = newId(ID_PREFIXES.notice);
    tx.insert(runResourceNotice)
      .values({
        id,
        projectId: input.key.projectId,
        machineId: input.key.machineId,
        runId: recipient.id,
        instanceId: recipient.instanceId,
        chatId: recipient.chatId,
        kind: input.kind,
        causeId: input.causeId,
        payloadJson: payload,
        createdAt: input.now,
        deliveredAt: null,
      })
      .onConflictDoNothing()
      .run();
    const row = tx.select().from(runResourceNotice).where(eq(runResourceNotice.id, id)).get();
    if (row) inserted.push(noticeView(row));
    else {
      const existing = tx
        .select()
        .from(runResourceNotice)
        .where(
          and(
            eq(runResourceNotice.kind, input.kind),
            eq(runResourceNotice.causeId, input.causeId),
            eq(runResourceNotice.runId, recipient.id),
          ),
        )
        .get();
      if (existing) inserted.push(noticeView(existing));
    }
  }
  return inserted;
}

/** 强制收回只补一次根因：原 cause 已有记录时不再写第二条通知。 */
export function hasNoticeCause(kind: RunResourceNoticeKind, causeId: string): boolean {
  return Boolean(
    db
      .select({ id: runResourceNotice.id })
      .from(runResourceNotice)
      .where(and(eq(runResourceNotice.kind, kind), eq(runResourceNotice.causeId, causeId)))
      .get(),
  );
}

function ownedRun(runId: string, ctx: { userId: string; requestId: string }) {
  const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  if (!run) throw new LeaseError("not_found");
  const owned = db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, run.projectId), eq(project.createdBy, ctx.userId)))
    .get();
  if (!owned) throw new LeaseError("not_found");
  return run;
}

/** 未投递通知按 `(createdAt,id)` 稳定排序；已投递的不会再次出现。 */
export function pendingRunNotices(
  input: { runId: string },
  ctx: { userId: string; requestId: string },
): RunResourceNotice[] {
  ownedRun(input.runId, ctx);
  return db
    .select()
    .from(runResourceNotice)
    .where(and(eq(runResourceNotice.runId, input.runId), isNull(runResourceNotice.deliveredAt)))
    .orderBy(asc(runResourceNotice.createdAt), asc(runResourceNotice.id))
    .all()
    .map(noticeView);
}

/** `delivered_at` 只标记投递完成，不等于已读；重复标记是 no-op。 */
export function markRunNoticeDelivered(noticeId: string, now: Date): boolean {
  const row = db
    .select({ id: runResourceNotice.id })
    .from(runResourceNotice)
    .where(and(eq(runResourceNotice.id, noticeId), isNull(runResourceNotice.deliveredAt)))
    .get();
  if (!row) return false;
  db.update(runResourceNotice)
    .set({ deliveredAt: now })
    .where(and(eq(runResourceNotice.id, noticeId), isNull(runResourceNotice.deliveredAt)))
    .run();
  return true;
}

/**
 * 读时投影用的最老未投递通知。`runNotRunning` 表示该 run 在投递前已经结束，
 * 事实视图据此显示 `run_not_running`，不冒充模型已读。
 */
export function oldestUndeliveredNotice(
  key: LeaseKey,
): { since: Date; runNotRunning: boolean } | null {
  const row = db
    .select({
      createdAt: runResourceNotice.createdAt,
      status: agentRun.status,
    })
    .from(runResourceNotice)
    .innerJoin(agentRun, eq(agentRun.id, runResourceNotice.runId))
    .where(
      and(
        eq(runResourceNotice.projectId, key.projectId),
        eq(runResourceNotice.machineId, key.machineId),
        isNull(runResourceNotice.deliveredAt),
      ),
    )
    .orderBy(asc(runResourceNotice.createdAt), asc(runResourceNotice.id))
    .get();
  if (!row) return null;
  return {
    since: row.createdAt,
    runNotRunning: row.status !== "running" && row.status !== "queued",
  };
}
