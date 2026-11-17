import { crewResourceRequest } from "../db/schema";
import { requestCrewResource, approveCrewResource, freezeCrewResources } from "./crew-resource";
export { waitForDelegationStart } from "./delegation-start";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  CrewDelegationView,
  DelegationStatus,
  DelegationView,
  DispatchDelegationInput,
  DispatchDelegationResult,
} from "../contracts/delegation";
import {
  cancelDelegationInput,
  type WorkerDelegationBlockInput,
  type WorkerDelegationResultInput,
} from "../contracts/delegation";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import {
  agentProfile,
  agentRun,
  chat,
  chatEffectiveMember,
  crewControl,
  delegation,
  delegationDelivery,
  delegationEvent,
  delegationResult,
  message,
  project,
} from "../db/schema";
import type { ProjectContext } from "./access";
import { abortAgentRun, attachDelegationInput, ensureDelegationWorkerRun } from "./agent-run";
import { ensureInstance, getChat, readCrewLeadId } from "./chat";

export type DelegationErrorCode = "invalid" | "forbidden" | "not_found" | "conflict";

export class DelegationError extends Error {
  constructor(
    readonly code: DelegationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DelegationError";
  }
}

type Actor = { kind: "human" | "agent"; id: string };

function actorOf(ctx: ProjectContext): Actor {
  return ctx.agent
    ? { kind: "agent", id: ctx.agent.agentProfileId }
    : { kind: "human", id: ctx.userId ?? "" };
}

function actorIsCrewMember(crewChatId: string, actor: Actor, projectId: string): boolean {
  return !!db
    .select({ memberId: chatEffectiveMember.memberId })
    .from(chatEffectiveMember)
    .where(
      and(
        eq(chatEffectiveMember.chatId, crewChatId),
        eq(chatEffectiveMember.projectId, projectId),
        eq(chatEffectiveMember.memberKind, actor.kind),
        eq(chatEffectiveMember.memberId, actor.id),
      ),
    )
    .get();
}

function assertCrewLeadOrHuman(crewChatId: string, ctx: ProjectContext): Actor {
  const actor = actorOf(ctx);
  if (!actorIsCrewMember(crewChatId, actor, getChat(crewChatId, ctx).projectId))
    throw new DelegationError("forbidden", "只有 Crew 成员可以委派");
  const lead = readCrewLeadId(crewChatId);
  if (actor.kind === "agent" && actor.id !== lead)
    throw new DelegationError("forbidden", "只有 lead 可以在 Crew 内发起委派");
  if (actor.kind === "human" && !actor.id) throw new DelegationError("forbidden", "缺少操作者");
  return actor;
}

function readCrewRow(chatId: string) {
  const row = db.select().from(chat).where(eq(chat.id, chatId)).get();
  if (!row || row.kind !== "crew") throw new DelegationError("not_found", "Crew 不存在");
  return row;
}

function readDelegationRow(delegationId: string) {
  const row = db.select().from(delegation).where(eq(delegation.id, delegationId)).get();
  if (!row) throw new DelegationError("not_found", "委派不存在");
  return row;
}

function insertEvent(input: {
  delegationId: string;
  kind: "dispatched" | "blocked" | "completed" | "failed" | "canceled";
  revision: number;
  summary: string;
  resultArtifactId?: string;
}): string {
  const id = newId(ID_PREFIXES.delegationEvent);
  db.insert(delegationEvent)
    .values({
      id,
      delegationId: input.delegationId,
      kind: input.kind,
      revision: input.revision,
      summary: input.summary,
      ...(input.resultArtifactId ? { resultArtifactId: input.resultArtifactId } : {}),
    })
    .run();
  return id;
}

/**
 * Dispatch is deterministic and durable: the child Chat, delegation row, dispatch event and the
 * worker's first input commit together. Explicit clientRequestId replays the existing record;
 * without a key, only an active delegation with the same Crew, worker and normalized text is reused.
 */
export function dispatchDelegation(
  input: Omit<DispatchDelegationInput, "clientRequestId"> & { clientRequestId?: string },
  ctx: ProjectContext,
): { delegationId: string; childChatId: string; status: DelegationStatus; created: boolean } {
  return sqlite
    .transaction(() => {
      const crewRow = readCrewRow(input.chatId);
      assertCrewLeadOrHuman(input.chatId, { ...ctx, requestId: ctx.requestId });
      const control = db
        .select()
        .from(crewControl)
        .where(eq(crewControl.chatId, input.chatId))
        .get();
      if (control?.mode === "stopped") throw new DelegationError("conflict", "Crew 已停止接入");
      const lead = readCrewLeadId(input.chatId);
      if (!lead) throw new DelegationError("conflict", "Crew 还没有 lead，不能委派");
      const worker = db
        .select()
        .from(agentProfile)
        .where(eq(agentProfile.id, input.workerProfileId))
        .get();
      if (!worker || worker.purpose !== "worker")
        throw new DelegationError("invalid", "只能委派给 worker Agent");
      if (input.workerProfileId === lead)
        throw new DelegationError("invalid", "lead 不能委派给自己");
      const workerMember = db
        .select({ memberId: chatEffectiveMember.memberId })
        .from(chatEffectiveMember)
        .where(
          and(
            eq(chatEffectiveMember.chatId, input.chatId),
            eq(chatEffectiveMember.projectId, crewRow.projectId),
            eq(chatEffectiveMember.memberKind, "agent"),
            eq(chatEffectiveMember.memberId, input.workerProfileId),
          ),
        )
        .get();
      if (!workerMember) throw new DelegationError("invalid", "该 Agent 不是 Crew 成员");
      if (input.clientRequestId === undefined) {
        const normalizeRequest = (request: string) => request.replace(/\r\n?/g, "\n").trim();
        const normalizedRequest = normalizeRequest(input.request);
        const active = db
          .select()
          .from(delegation)
          .where(
            and(
              eq(delegation.parentCrewChatId, input.chatId),
              eq(delegation.workerProfileId, input.workerProfileId),
              inArray(delegation.status, ["queued", "running", "blocked", "canceling"]),
            ),
          )
          .orderBy(asc(delegation.createdAt), asc(delegation.id))
          .all()
          .find(
            (row: typeof delegation.$inferSelect) =>
              normalizeRequest(row.requestSummary) === normalizedRequest,
          );
        if (active)
          return {
            delegationId: active.id,
            childChatId: active.childChatId,
            status: active.status,
            created: false,
          };
      }
      const clientRequestId = input.clientRequestId ?? newId(ID_PREFIXES.request);
      const existing =
        input.clientRequestId === undefined
          ? undefined
          : db
              .select()
              .from(delegation)
              .where(
                and(
                  eq(delegation.parentCrewChatId, input.chatId),
                  eq(delegation.clientRequestId, clientRequestId),
                ),
              )
              .get();
      if (existing) {
        const previous = db
          .select()
          .from(crewResourceRequest)
          .where(eq(crewResourceRequest.delegationId, existing.id))
          .all()
          .filter((r: typeof crewResourceRequest.$inferSelect) =>
            r.clientRequestId.startsWith(`dispatch:${clientRequestId}:`),
          );
        const canonical = (
          rows: {
            machineId: string;
            membershipEpoch: number;
            directoryRealPath: string;
            directoryRevision: number;
            operations: string[];
          }[],
        ) =>
          JSON.stringify(
            rows
              .map((r) => ({
                machineId: r.machineId,
                membershipEpoch: r.membershipEpoch,
                directoryRealPath: r.directoryRealPath,
                directoryRevision: r.directoryRevision,
                operations: [...new Set(r.operations)].sort(),
              }))
              .sort((a, b) => a.machineId.localeCompare(b.machineId)),
          );
        if (
          canonical(
            previous.map((r: typeof crewResourceRequest.$inferSelect) => ({
              ...r,
              operations: JSON.parse(r.operationsJson) as string[],
            })),
          ) !== canonical(input.resources ?? [])
        )
          throw new DelegationError("conflict", "同一 dispatch key 的资源 payload 不一致");
        return {
          delegationId: existing.id,
          childChatId: existing.childChatId,
          status: existing.status,
          created: false,
        };
      }
      const childChatId = newId(ID_PREFIXES.chat);
      db.insert(chat)
        .values({
          id: childChatId,
          projectId: crewRow.projectId,
          kind: "delegation",
          parentCrewChatId: input.chatId,
          title: `委派给 ${worker.name}`,
          ownerKind: "human",
          ownerId: crewRow.createdBy,
          createdBy: crewRow.createdBy,
        })
        .run();
      const delegationId = newId(ID_PREFIXES.delegation);
      db.insert(delegation)
        .values({
          id: delegationId,
          projectId: crewRow.projectId,
          parentCrewChatId: input.chatId,
          childChatId,
          dispatchLeadProfileId: lead,
          crewEpoch: crewRow.crewEpoch,
          workerProfileId: input.workerProfileId,
          requestSummary: input.request,
          status: "running",
          clientRequestId,
          startedAt: new Date(),
        })
        .run();
      insertEvent({
        delegationId,
        kind: "dispatched",
        revision: 0,
        summary: input.request,
      });
      const requestMessageId = newId(ID_PREFIXES.message);
      db.insert(message)
        .values({
          id: requestMessageId,
          chatId: childChatId,
          senderKind: "agent",
          senderId: lead,
          body: input.request,
          delegationId,
        })
        .run();
      const systemContext = projectContextFor(crewRow.projectId);
      const instance = ensureInstance(childChatId, input.workerProfileId, systemContext);
      db.update(delegation)
        .set({ workerInstanceId: instance.id, updatedAt: new Date() })
        .where(eq(delegation.id, delegationId))
        .run();
      const workerRunId = ensureDelegationWorkerRun(
        childChatId,
        input.workerProfileId,
        requestMessageId,
        systemContext,
      );
      if (input.resources?.length) {
        if (!ctx.agent) throw new DelegationError("forbidden", "资源预批准需要当前 lead run");
        const resourceActor = {
          projectId: crewRow.projectId,
          instanceId: ctx.agent.instanceId,
          runId: ctx.agent.runId,
        };
        for (const scope of input.resources) {
          const request = requestCrewResource(
            {
              ...scope,
              crewChatId: crewRow.id,
              crewEpoch: crewRow.crewEpoch,
              subjectKind: "delegation",
              delegationId,
              attempt: 1,
              runId: workerRunId,
              clientRequestId: `dispatch:${clientRequestId}:${scope.machineId}`,
            },
            resourceActor,
          );
          approveCrewResource(
            {
              resourceRequestId: request.id,
              crewEpoch: crewRow.crewEpoch,
              expectedRevision: request.revision,
            },
            resourceActor,
          );
        }
      }
      return { delegationId, childChatId, status: "running", created: true };
    })
    .immediate();
}

/**
 * Creates the lead-facing delivery for one terminal/blocked event. Delivery is separate from the
 * worker chat: the event snapshots the current lead and Crew epoch, and is revalidated before it
 * can create a lead run.
 */
export function enqueueDelegationDelivery(delegationId: string, eventId: string): string {
  const row = readDelegationRow(delegationId);
  const id = newId(ID_PREFIXES.delegationDelivery);
  db.insert(delegationDelivery)
    .values({
      id,
      delegationId,
      eventId,
      leadProfileId: row.dispatchLeadProfileId,
      crewEpoch: row.crewEpoch,
      state: "pending",
    })
    .onConflictDoNothing()
    .run();
  return id;
}

export function deliverPendingDelegations(): number {
  resetStaleDelegationDeliveries();
  const pending = db
    .select()
    .from(delegationDelivery)
    .where(eq(delegationDelivery.state, "pending"))
    .orderBy(asc(delegationDelivery.createdAt))
    .limit(50)
    .all();
  if (pending.length === 0) return 0;
  // 同一 lead、同一 Crew epoch 的结果合成一条 prompt；按 UTF-8 字节上限 32KiB 分批，超出的留到下一批。
  const groups = new Map<string, (typeof pending)[number][]>();
  let batch = 0;
  let size = 0;
  for (const item of pending) {
    const row = db.select().from(delegation).where(eq(delegation.id, item.delegationId)).get();
    if (!row) continue;
    const bytes = deliveryBytes(row);
    if (size > 0 && size + bytes > DELIVERY_BATCH_BYTES) {
      batch += 1;
      size = 0;
    }
    size += bytes;
    const key = `${row.parentCrewChatId}|${item.leadProfileId}|${item.crewEpoch}|${batch}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  let delivered = 0;
  for (const items of groups.values()) delivered += deliverDeliveryGroup(items) ? items.length : 0;
  return delivered;
}

const DELIVERY_BATCH_BYTES = 32 * 1024;

function deliveryBytes(row: typeof delegation.$inferSelect): number {
  return Buffer.byteLength(
    `委派结果：${row.workerProfileId} · completed\n${row.terminalSummary ?? ""}\n委派对话：${row.childChatId}`,
    "utf8",
  );
}

/** bound 但宿主从未 admit 的投递，在宿主 run 终止后重新排队，避免结果永久滞留。 */
function resetStaleDelegationDeliveries(): void {
  const bound = db
    .select({ id: delegationDelivery.id, runId: delegationDelivery.runId })
    .from(delegationDelivery)
    .where(eq(delegationDelivery.state, "bound"))
    .all();
  for (const item of bound) {
    if (!item.runId) continue;
    const run = db.select().from(agentRun).where(eq(agentRun.id, item.runId)).get();
    if (!run || run.status === "queued" || run.status === "running") continue;
    db.update(delegationDelivery)
      .set({ state: "pending", runId: null, messageId: null, updatedAt: new Date() })
      .where(eq(delegationDelivery.id, item.id))
      .run();
  }
}

/** 投递前的发送边界复核：lead/epoch/停止状态都可能在 bind 之后变化。 */
export function confirmDelegationDelivery(
  runId: string,
  messageId: string,
): "ok" | "absent" | "invalid" {
  return sqlite
    .transaction(() => {
      const items = db
        .select()
        .from(delegationDelivery)
        .where(
          and(eq(delegationDelivery.runId, runId), eq(delegationDelivery.messageId, messageId)),
        )
        .all();
      if (items.length === 0) return "absent" as const;
      const first = db
        .select()
        .from(delegation)
        .where(eq(delegation.id, items[0]!.delegationId))
        .get();
      const crewRow = first
        ? db.select().from(chat).where(eq(chat.id, first.parentCrewChatId)).get()
        : undefined;
      const control = crewRow
        ? db.select().from(crewControl).where(eq(crewControl.chatId, crewRow.id)).get()
        : undefined;
      const invalid =
        !crewRow || crewRow.kind !== "crew"
          ? "crew_missing"
          : crewRow.leadProfileId !== items[0]!.leadProfileId ||
              crewRow.crewEpoch !== items[0]!.crewEpoch
            ? "lead_changed"
            : control?.mode === "stopped"
              ? "crew_stopped"
              : null;
      if (invalid) {
        for (const item of items) markAttention(item.id, invalid);
        return "invalid" as const;
      }
      const now = new Date();
      for (const item of items) {
        db.update(delegationDelivery)
          .set({ state: "injected", injectedAt: now, updatedAt: now })
          .where(eq(delegationDelivery.id, item.id))
          .run();
      }
      return "ok" as const;
    })
    .immediate();
}

/** 发送失败时退回 pending，下一轮 tick 重试；已 admit 的行不受影响。 */
export function releaseDelegationDelivery(runId: string, messageId: string): void {
  db.update(delegationDelivery)
    .set({ state: "pending", runId: null, messageId: null, updatedAt: new Date() })
    .where(
      and(
        eq(delegationDelivery.runId, runId),
        eq(delegationDelivery.messageId, messageId),
        eq(delegationDelivery.state, "injected"),
      ),
    )
    .run();
}

/** 结果批次写入专用 inbox 对话，避免 sibling 结果进入某个 worker 子对话的人类时间线。 */
function delegationInboxChat(crewRow: typeof chat.$inferSelect): typeof chat.$inferSelect {
  const existing = db
    .select()
    .from(chat)
    .where(
      and(
        eq(chat.kind, "delegation"),
        eq(chat.parentCrewChatId, crewRow.id),
        eq(chat.title, "委派结果"),
      ),
    )
    .get();
  if (existing) return existing;
  const id = newId(ID_PREFIXES.chat);
  db.insert(chat)
    .values({
      id,
      projectId: crewRow.projectId,
      kind: "delegation",
      title: "委派结果",
      ownerKind: "human",
      ownerId: crewRow.createdBy,
      createdBy: crewRow.createdBy,
      parentCrewChatId: crewRow.id,
    })
    .run();
  return db.select().from(chat).where(eq(chat.id, id)).get()!;
}

function deliverDeliveryGroup(items: (typeof delegationDelivery.$inferSelect)[]): boolean {
  return sqlite
    .transaction(() => {
      const first = db
        .select()
        .from(delegation)
        .where(eq(delegation.id, items[0]!.delegationId))
        .get();
      if (!first) return false;
      const crewRow = db.select().from(chat).where(eq(chat.id, first.parentCrewChatId)).get();
      const control = crewRow
        ? db.select().from(crewControl).where(eq(crewControl.chatId, crewRow.id)).get()
        : undefined;
      const invalid =
        !crewRow || crewRow.kind !== "crew"
          ? "crew_missing"
          : crewRow.leadProfileId !== items[0]!.leadProfileId ||
              crewRow.crewEpoch !== items[0]!.crewEpoch
            ? "lead_changed"
            : crewRow.crewEpoch !== first.crewEpoch
              ? "epoch_changed"
              : control?.mode === "stopped"
                ? "crew_stopped"
                : null;
      if (invalid) {
        for (const item of items) markAttention(item.id, invalid);
        return false;
      }
      const lines: string[] = [];
      for (const item of items) {
        const row = db.select().from(delegation).where(eq(delegation.id, item.delegationId)).get();
        const event = db
          .select()
          .from(delegationEvent)
          .where(eq(delegationEvent.id, item.eventId))
          .get();
        const worker = row
          ? db
              .select({ name: agentProfile.name })
              .from(agentProfile)
              .where(eq(agentProfile.id, row.workerProfileId))
              .get()
          : undefined;
        if (!row || !event) {
          markAttention(item.id, "event_missing");
          continue;
        }
        lines.push(
          `委派结果：${worker?.name ?? row.workerProfileId} · ${event.kind}\n${event.summary}\n委派对话：${row.childChatId}`,
        );
      }
      if (lines.length === 0) return false;
      const body = lines.join("\n\n");
      const messageId = newId(ID_PREFIXES.message);
      const firstRow = db
        .select()
        .from(delegation)
        .where(eq(delegation.id, items[0]!.delegationId))
        .get()!;
      const inbox = delegationInboxChat(crewRow);
      db.insert(message)
        .values({
          id: messageId,
          chatId: inbox.id,
          senderKind: "agent",
          senderId: firstRow.workerProfileId,
          body,
          delegationPromptForChatId: crewRow.id,
        })
        .run();
      const instance = ensureInstance(
        crewRow.id,
        items[0]!.leadProfileId,
        projectContextFor(firstRow.projectId),
      );
      const runId = attachDelegationInput(messageId, crewRow.id, instance.id, firstRow.projectId);
      const now = new Date();
      for (const item of items) {
        db.update(delegationDelivery)
          .set({
            state: "bound",
            runId,
            messageId,
            attempts: item.attempts + 1,
            boundAt: now,
            updatedAt: now,
          })
          .where(eq(delegationDelivery.id, item.id))
          .run();
      }
      return true;
    })
    .immediate();
}

function markAttention(deliveryId: string, reason: string): void {
  db.update(delegationDelivery)
    .set({
      state: "attention",
      attentionReason: reason,
      runId: null,
      messageId: null,
      updatedAt: new Date(),
    })
    .where(eq(delegationDelivery.id, deliveryId))
    .run();
}

export function deliverDelegation(deliveryId: string): boolean {
  return sqlite
    .transaction(() => {
      const delivery = db
        .select()
        .from(delegationDelivery)
        .where(eq(delegationDelivery.id, deliveryId))
        .get();
      if (!delivery || delivery.state !== "pending") return false;
      const row = readDelegationRow(delivery.delegationId);
      const crewRow = db.select().from(chat).where(eq(chat.id, row.parentCrewChatId)).get();
      const control = crewRow
        ? db.select().from(crewControl).where(eq(crewControl.chatId, crewRow.id)).get()
        : undefined;
      const attention = (reason: string) => {
        db.update(delegationDelivery)
          .set({
            state: "attention",
            attentionReason: reason,
            runId: null,
            messageId: null,
            updatedAt: new Date(),
          })
          .where(eq(delegationDelivery.id, deliveryId))
          .run();
        return false;
      };
      if (!crewRow || crewRow.kind !== "crew") return attention("crew_missing");
      if (crewRow.leadProfileId !== delivery.leadProfileId) return attention("lead_changed");
      if (crewRow.crewEpoch !== delivery.crewEpoch) return attention("epoch_changed");
      if (control?.mode === "stopped") return attention("crew_stopped");
      const event = db
        .select()
        .from(delegationEvent)
        .where(eq(delegationEvent.id, delivery.eventId))
        .get();
      if (!event) return attention("event_missing");
      const worker = db
        .select()
        .from(agentProfile)
        .where(eq(agentProfile.id, row.workerProfileId))
        .get();
      const body = [
        `委派结果：${worker?.name ?? row.workerProfileId} · ${event.kind}`,
        event.summary,
        `委派对话：${row.childChatId}`,
      ].join("\n");
      const messageId = newId(ID_PREFIXES.message);
      const inbox = delegationInboxChat(crewRow);
      db.insert(message)
        .values({
          id: messageId,
          chatId: inbox.id,
          senderKind: "agent",
          senderId: row.workerProfileId,
          body,
          delegationId: row.id,
          delegationPromptForChatId: crewRow.id,
        })
        .run();
      const instance = ensureInstance(
        crewRow.id,
        delivery.leadProfileId,
        projectContextFor(row.projectId),
      );
      const runId = attachDelegationInput(messageId, crewRow.id, instance.id, row.projectId);
      db.update(delegationDelivery)
        .set({
          state: "bound",
          runId,
          messageId,
          attempts: delivery.attempts + 1,
          boundAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(delegationDelivery.id, deliveryId))
        .run();
      return true;
    })
    .immediate();
}

/** Internal system context for delivery; the domain already revalidated crew membership. */
function projectContextFor(projectId: string): ProjectContext {
  const owner = db
    .select({ createdBy: project.createdBy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  if (!owner) throw new DelegationError("not_found", "Project 不存在");
  return { userId: owner.createdBy, requestId: `delegation-delivery-${projectId}` };
}

/**
 * 结算 worker run 已经终止、但委派行还停在 running 的窗口。进程崩溃或恢复扫描会把 run 标成
 * failed/canceled，却没有 worker 来调 complete/block；没有这条兜底，lead 永远收不到终态。
 */
export function reconcileDelegations(): number {
  const rows = db
    .select()
    .from(delegation)
    .where(inArray(delegation.status, ["queued", "running", "canceling"]))
    .all();
  let settled = 0;
  for (const row of rows) {
    const active = db
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(
        and(eq(agentRun.chatId, row.childChatId), inArray(agentRun.status, ["queued", "running"])),
      )
      .get();
    if (active) continue;
    const latest = db
      .select()
      .from(agentRun)
      .where(eq(agentRun.chatId, row.childChatId))
      .orderBy(desc(agentRun.queuedAt))
      .get();
    if (!latest) continue;
    if (
      latest.status !== "failed" &&
      latest.status !== "interrupted" &&
      latest.status !== "aborted"
    )
      continue;
    sqlite
      .transaction(() => {
        const current = db.select().from(delegation).where(eq(delegation.id, row.id)).get();
        if (!current || (current.status !== "running" && current.status !== "canceling")) return;
        if (
          current.status === "canceling" ||
          (latest.status === "aborted" && latest.stopReason === "human_stop")
        ) {
          settle(current.id, "canceled", "canceled", current.terminalSummary ?? "已取消");
        } else {
          settle(
            current.id,
            "failed",
            "interrupted",
            latest.stopReason ?? "worker 执行中断，未提交结果",
          );
        }
        settled += 1;
      })
      .immediate();
  }
  if (settled > 0) deliverPendingDelegations();
  return settled;
}

export function acknowledgeDelegationDelivery(runId: string, messageId: string): void {
  db.update(delegationDelivery)
    .set({
      state: "acknowledged",
      injectedAt: new Date(),
      acknowledgedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(delegationDelivery.runId, runId),
        eq(delegationDelivery.messageId, messageId),
        inArray(delegationDelivery.state, ["bound", "injected"]),
      ),
    )
    .run();
}

function insertCompletionMessage(row: ReturnType<typeof readDelegationRow>, summary: string): void {
  const existing = db
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.delegationId, row.id), eq(message.senderKind, "delegation_event")))
    .get();
  if (existing) return;
  db.insert(message)
    .values({
      id: newId(ID_PREFIXES.message),
      chatId: row.parentCrewChatId,
      senderKind: "delegation_event",
      senderId: row.id,
      body: summary.trim() || "委派已结束",
      delegationId: row.id,
    })
    .run();
}

function settle(
  delegationId: string,
  status: "completed" | "failed" | "canceled",
  reason:
    | "completed"
    | "failed"
    | "canceled"
    | "interrupted"
    | "crew_stopped"
    | "resource_unavailable",
  summary: string,
  artifact?: WorkerDelegationResultInput["artifact"],
): void {
  const row = readDelegationRow(delegationId);
  if (row.status === "completed" || row.status === "failed" || row.status === "canceled") return;
  const revision = row.resultRevision + 1;
  let artifactId: string | undefined;
  if (artifact) {
    artifactId = newId(ID_PREFIXES.delegationResult);
    db.insert(delegationResult)
      .values({
        id: artifactId,
        delegationId,
        projectId: row.projectId,
        title: artifact.title,
        content: artifact.html,
        byteSize: Buffer.byteLength(artifact.html, "utf8"),
      })
      .run();
  }
  db.update(delegation)
    .set({
      status,
      resultRevision: revision,
      terminalSummary: summary,
      terminalReason: reason,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(delegation.id, delegationId))
    .run();
  freezeCrewResources({ delegationId }, "delegation_terminal");
  const eventId = insertEvent({
    delegationId,
    kind: status === "completed" ? "completed" : status === "failed" ? "failed" : "canceled",
    revision,
    summary,
    ...(artifactId ? { resultArtifactId: artifactId } : {}),
  });
  insertCompletionMessage(row, summary);
  enqueueDelegationDelivery(delegationId, eventId);
}

function assertWorkerRun(ctx: ProjectContext, delegationId: string) {
  const row = readDelegationRow(delegationId);
  if (!ctx.agent || ctx.agent.agentProfileId !== row.workerProfileId)
    throw new DelegationError("forbidden", "只有被委派的 Agent 可以提交结果");
  if (row.workerInstanceId !== ctx.agent.instanceId)
    throw new DelegationError("forbidden", "只能在委派对话内提交结果");
  return row;
}

export function completeDelegation(
  delegationId: string,
  result: WorkerDelegationResultInput,
  ctx: ProjectContext,
): { delegationId: string; status: DelegationStatus } {
  sqlite
    .transaction(() => {
      const row = assertWorkerRun(ctx, delegationId);
      if (row.status !== "running") throw new DelegationError("conflict", "委派已结束");
      settle(delegationId, "completed", "completed", result.summary, result.artifact);
    })
    .immediate();
  deliverPendingDelegations();
  return { delegationId, status: "completed" };
}

export function blockDelegation(
  delegationId: string,
  input: WorkerDelegationBlockInput,
  ctx: ProjectContext,
): { delegationId: string; status: DelegationStatus } {
  sqlite
    .transaction(() => {
      const row = assertWorkerRun(ctx, delegationId);
      if (row.status !== "running") throw new DelegationError("conflict", "委派已结束");
      if (input.reason === "failed") {
        settle(delegationId, "failed", "failed", input.summary);
        return;
      }
      const revision = row.resultRevision + 1;
      db.update(delegation)
        .set({
          status: "blocked",
          resultRevision: revision,
          terminalSummary: input.summary,
          terminalReason: null,
          settledAt: null,
          updatedAt: new Date(),
        })
        .where(eq(delegation.id, delegationId))
        .run();
      const eventId = insertEvent({
        delegationId,
        kind: "blocked",
        revision,
        summary: input.summary,
      });
      enqueueDelegationDelivery(delegationId, eventId);
    })
    .immediate();
  deliverPendingDelegations();
  return { delegationId, status: "blocked" };
}

export function sendDelegationInput(
  delegationId: string,
  text: string,
  ctx: ProjectContext,
): { delegationId: string; messageId: string } {
  return sqlite.transaction(() => {
    const row = db.select().from(delegation).where(eq(delegation.id, delegationId)).get();
    if (!row) throw new DelegationError("not_found", "委派不存在");
    const actor = assertCrewLeadOrHuman(row.parentCrewChatId, ctx);
    if (row.status !== "queued" && row.status !== "running")
      throw new DelegationError("conflict", "委派已经结束，不能再追加输入");
    const messageId = newId(ID_PREFIXES.message);
    db.insert(message)
      .values({
        id: messageId,
        projectId: row.projectId,
        chatId: row.childChatId,
        senderKind: actor.kind,
        senderId: actor.id,
        body: text,
      })
      .run();
    const owner = db
      .select({ createdBy: project.createdBy })
      .from(project)
      .where(eq(project.id, row.projectId))
      .get();
    // 追加输入发生在 worker 的对话里，但当前身份是 lead 的 Crew run；用 Project owner 的
    // 人类范围做内部投递，避免把 lead run 的 chatId 冒充成子对话。
    ensureDelegationWorkerRun(row.childChatId, row.workerProfileId, messageId, {
      userId: owner?.createdBy ?? "",
      requestId: ctx.requestId,
    });
    return { delegationId: row.id, messageId };
  })();
}

export function cancelDelegation(
  input: { delegationId: string; reason: string },
  ctx: ProjectContext,
): { delegationId: string; status: "canceled" } | undefined {
  const canceled = sqlite
    .transaction(() => {
      const row = readDelegationRow(input.delegationId);
      assertCrewLeadOrHuman(row.parentCrewChatId, ctx);
      if (row.status === "completed" || row.status === "failed" || row.status === "canceled")
        return false;
      const running = db
        .select({ runId: agentRun.id })
        .from(agentRun)
        .where(
          and(
            eq(agentRun.chatId, row.childChatId),
            inArray(agentRun.status, ["queued", "running"]),
          ),
        )
        .get();
      if (running) {
        const run = db.select().from(agentRun).where(eq(agentRun.id, running.runId)).get();
        if (run) abortAgentRun(run.id, ctx);
      }
      settle(input.delegationId, "canceled", "canceled", input.reason);
      return true;
    })
    .immediate();
  if (!canceled) return;
  deliverPendingDelegations();
  return { delegationId: input.delegationId, status: "canceled" as const };
}

export function retryDelegation(
  input: { delegationId: string; clientRequestId: string },
  ctx: ProjectContext,
): DispatchDelegationResult {
  const row = readDelegationRow(input.delegationId);
  assertCrewLeadOrHuman(row.parentCrewChatId, ctx);
  if (row.status !== "failed" && row.status !== "blocked" && row.status !== "canceled")
    throw new DelegationError("conflict", "只有失败的委派可以重试");
  return dispatchDelegation(
    {
      chatId: row.parentCrewChatId,
      workerProfileId: row.workerProfileId,
      request: row.requestSummary,
      clientRequestId: input.clientRequestId,
    },
    ctx,
  );
}

export function cancelCrewDelegations(
  crewChatId: string,
  reason: string,
  ctx: ProjectContext,
): number {
  const rows = db
    .select({ id: delegation.id })
    .from(delegation)
    .where(
      and(
        eq(delegation.parentCrewChatId, crewChatId),
        inArray(delegation.status, ["queued", "running", "blocked", "canceling"]),
      ),
    )
    .all();
  for (const row of rows) cancelDelegation({ delegationId: row.id, reason }, ctx);
  return rows.length;
}

export function listCrewDelegations(chatId: string, ctx: ProjectContext): CrewDelegationView {
  readCrewRow(chatId);
  getChat(chatId, ctx);
  const rows = db
    .select({
      row: delegation,
      workerName: agentProfile.name,
    })
    .from(delegation)
    .innerJoin(agentProfile, eq(agentProfile.id, delegation.workerProfileId))
    .where(eq(delegation.parentCrewChatId, chatId))
    .orderBy(desc(delegation.createdAt), desc(delegation.id))
    .all();
  const eventRows = db
    .select({
      event: delegationEvent,
      deliveryState: delegationDelivery.state,
    })
    .from(delegationEvent)
    .leftJoin(delegationDelivery, eq(delegationDelivery.eventId, delegationEvent.id))
    .innerJoin(delegation, eq(delegation.id, delegationEvent.delegationId))
    .where(eq(delegation.parentCrewChatId, chatId))
    .orderBy(desc(delegationEvent.createdAt), desc(delegationEvent.id))
    .all();
  type Row = { row: typeof delegation.$inferSelect; workerName: string };
  type EventRow = { event: typeof delegationEvent.$inferSelect; deliveryState: string | null };
  const delegations: DelegationView[] = (rows as Row[]).map(({ row, workerName }) => ({
    id: row.id,
    parentCrewChatId: row.parentCrewChatId,
    childChatId: row.childChatId,
    workerProfileId: row.workerProfileId,
    workerName,
    dispatchLeadProfileId: row.dispatchLeadProfileId,
    crewEpoch: row.crewEpoch,
    requestSummary: row.requestSummary,
    status: row.status,
    attempt: row.attempt,
    resultRevision: row.resultRevision,
    terminalSummary: row.terminalSummary,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    settledAt: row.settledAt?.getTime() ?? null,
  }));
  return {
    delegations,
    events: (eventRows as EventRow[]).map(({ event, deliveryState }) => ({
      id: event.id,
      delegationId: event.delegationId,
      kind: event.kind,
      revision: event.revision,
      summary: event.summary,
      resultArtifactId: event.resultArtifactId,
      progressCount: event.progressCount,
      deliveryState: (deliveryState ?? "pending") as DelegationView["status"] extends never
        ? never
        : "pending",
      createdAt: event.createdAt.getTime(),
    })),
  };
}

export function readDelegationResult(artifactId: string, ctx: ProjectContext) {
  const row = db.select().from(delegationResult).where(eq(delegationResult.id, artifactId)).get();
  if (!row) throw new DelegationError("not_found", "结果不存在");
  const del = readDelegationRow(row.delegationId);
  getChat(del.parentCrewChatId, ctx);
  return row;
}

export { cancelDelegationInput };
