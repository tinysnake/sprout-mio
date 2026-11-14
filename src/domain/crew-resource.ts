import { createHash } from "node:crypto";
import { posix } from "node:path";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  crewResourceRequestSchema,
  type CrewResourceRequestInput,
  type CrewResourceDecisionInput,
} from "../contracts/crew-resource";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentRun,
  chat,
  chatEffectiveMember,
  crewControl,
  crewResourceRequest,
  crewResourceEvent,
  delegation,
  directoryObservation,
  machine,
  machineConnection,
  leaseAuthorization,
  leaseGrant,
  leaseMutation,
  machineLease,
  projectMachineMembership,
  remoteExecution,
} from "../db/schema";
import { attachDelegationInput } from "./agent-run";
import { ensureInstance } from "./chat";
import { agentRunInput, message, project } from "../db/schema";
import { completeLeaseMutation, ensureLease } from "../server/lease";

type Request = typeof crewResourceRequest.$inferSelect;
export type CrewResourceActor = { projectId: string; instanceId: string; runId: string };
export class CrewResourceError extends Error {
  constructor(
    readonly code: "forbidden" | "conflict" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new CrewResourceError("forbidden", message);
};
function atomic<T>(fn: () => T): T {
  return sqlite.inTransaction ? fn() : sqlite.transaction(fn).immediate();
}
function read(id: string): Request {
  const r = db.select().from(crewResourceRequest).where(eq(crewResourceRequest.id, id)).get();
  if (!r) throw new CrewResourceError("not_found", "资源请求不存在");
  return r;
}
function lead(crewId: string, epoch: number, actor: CrewResourceActor) {
  const c = db.select().from(chat).where(eq(chat.id, crewId)).get();
  const i = db.select().from(agentInstance).where(eq(agentInstance.id, actor.instanceId)).get();
  const r = db.select().from(agentRun).where(eq(agentRun.id, actor.runId)).get();
  if (
    !c ||
    c.kind !== "crew" ||
    c.archivedAt ||
    c.projectId !== actor.projectId ||
    c.crewEpoch !== epoch ||
    !i ||
    i.chatId !== c.id ||
    i.agentProfileId !== c.leadProfileId ||
    !r ||
    r.instanceId !== i.id ||
    r.status !== "running"
  )
    fail("需要当前 epoch 的 lead run");
  if (
    db.select().from(crewControl).where(eq(crewControl.chatId, c.id)).get()?.mode === "stopped" ||
    !db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.chatId, c.id),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, i.agentProfileId),
        ),
      )
      .get()
  )
    fail("Crew 已停止或 lead 已移除");
  return { crew: c, instance: i };
}
function eligibility(r: Request): string | null {
  const c = db.select().from(chat).where(eq(chat.id, r.crewChatId)).get();
  const control = db.select().from(crewControl).where(eq(crewControl.chatId, r.crewChatId)).get();
  const run = db.select().from(agentRun).where(eq(agentRun.id, r.runId)).get();
  const instance = db.select().from(agentInstance).where(eq(agentInstance.id, r.instanceId)).get();
  if (
    !c ||
    c.kind !== "crew" ||
    c.archivedAt ||
    c.projectId !== r.projectId ||
    c.crewEpoch !== r.crewEpoch
  )
    return "crew_epoch_changed";
  if (control?.mode === "stopped") return "crew_stopped";
  if (
    !c.leadProfileId ||
    !db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.chatId, c.id),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, c.leadProfileId),
        ),
      )
      .get()
  )
    return "lead_removed";
  if (
    !run ||
    run.instanceId !== r.instanceId ||
    run.chatId !== r.chatId ||
    run.projectId !== r.projectId ||
    !["queued", "running"].includes(run.status)
  )
    return "run_terminal";
  if (
    !instance ||
    !db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.chatId, c.id),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, instance.agentProfileId),
        ),
      )
      .get()
  )
    return "member_removed";
  if (r.subjectKind === "delegation") {
    const d = r.delegationId
      ? db.select().from(delegation).where(eq(delegation.id, r.delegationId)).get()
      : null;
    if (
      !d ||
      d.parentCrewChatId !== c.id ||
      d.crewEpoch !== r.crewEpoch ||
      d.attempt !== r.attempt ||
      d.workerInstanceId !== r.instanceId ||
      d.childChatId !== r.chatId ||
      !["running", "blocked"].includes(d.status)
    )
      return "delegation_invalid";
  } else if (instance.agentProfileId !== c.leadProfileId || instance.chatId !== c.id)
    return "lead_changed";
  const member = db
    .select()
    .from(projectMachineMembership)
    .where(
      and(
        eq(projectMachineMembership.projectId, r.projectId),
        eq(projectMachineMembership.machineId, r.machineId),
        eq(projectMachineMembership.epoch, r.membershipEpoch),
      ),
    )
    .get();
  if (member?.state !== "active") return "machine_membership_changed";
  const currentMachine = db.select().from(machine).where(eq(machine.id, r.machineId)).get();
  const currentConnection = db
    .select()
    .from(machineConnection)
    .where(eq(machineConnection.machineId, r.machineId))
    .orderBy(desc(machineConnection.generation))
    .get();
  if (currentMachine?.rootRevision !== r.directoryRevision || !currentConnection)
    return "directory_changed";
  const observation = db
    .select()
    .from(directoryObservation)
    .where(
      and(
        eq(directoryObservation.machineId, r.machineId),
        eq(directoryObservation.projectId, r.projectId),
        eq(directoryObservation.generation, currentConnection.generation),
        eq(directoryObservation.revision, r.directoryRevision),
      ),
    )
    .get();
  if (
    !observation ||
    observation.kind !== "accessible" ||
    observation.realPath !== r.directoryRealPath
  )
    return "directory_changed";
  return null;
}
function event(r: Request, kind: string, audience: "worker" | "lead" | "human" = "worker") {
  db.insert(crewResourceEvent)
    .values({
      id: crypto.randomUUID(),
      requestId: r.id,
      revision: r.revision,
      kind,
      audience,
      crewEpoch: r.crewEpoch,
      state: "pending",
      payloadJson: JSON.stringify({
        state: r.state,
        reason: r.reason,
        grantId: r.grantId,
        crewChatId: r.crewChatId,
        crewEpoch: r.crewEpoch,
        subjectKind: r.subjectKind,
        delegationId: r.delegationId,
        attempt: r.attempt,
        runId: r.runId,
        instanceId: r.instanceId,
        machineId: r.machineId,
        membershipEpoch: r.membershipEpoch,
        directoryRealPath: r.directoryRealPath,
        directoryRevision: r.directoryRevision,
        operations: JSON.parse(r.operationsJson),
        approval: r.approval,
      }),
    })
    .onConflictDoNothing()
    .run();
}
function update(r: Request, patch: Partial<Request>, kind: string) {
  db.update(crewResourceRequest)
    .set({ ...patch, revision: r.revision + 1, updatedAt: new Date() })
    .where(and(eq(crewResourceRequest.id, r.id), eq(crewResourceRequest.revision, r.revision)))
    .run();
  const current = read(r.id);
  event(current, kind);
  if (current.state === "attention") event(current, kind, "human");
  return current;
}
export function requestCrewResource(
  input: CrewResourceRequestInput,
  actor: CrewResourceActor,
): Request {
  const parsed = crewResourceRequestSchema.parse(input);
  if (
    parsed.subjectKind === "delegation"
      ? !parsed.delegationId || !parsed.attempt
      : parsed.delegationId !== undefined || parsed.attempt !== undefined
  )
    throw new CrewResourceError("invalid", "subject 与 delegation/attempt 不一致");
  return atomic(() => {
    const run = db.select().from(agentRun).where(eq(agentRun.id, parsed.runId)).get();
    if (!run || run.projectId !== actor.projectId) fail("run 不属于本 Project");
    if (parsed.runId !== actor.runId || run.instanceId !== actor.instanceId)
      lead(parsed.crewChatId, parsed.crewEpoch, actor);
    const canonical = { ...parsed, operations: [...new Set(parsed.operations)].sort() };
    const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const existing = db
      .select()
      .from(crewResourceRequest)
      .where(
        and(
          eq(crewResourceRequest.crewChatId, parsed.crewChatId),
          eq(crewResourceRequest.clientRequestId, parsed.clientRequestId),
        ),
      )
      .get();
    if (existing) {
      if (existing.payloadHash !== hash)
        throw new CrewResourceError("conflict", "同一 clientRequestId 的 payload 已改变");
      return existing;
    }
    const now = new Date();
    const r: Request = {
      id: crypto.randomUUID(),
      projectId: actor.projectId,
      crewChatId: parsed.crewChatId,
      crewEpoch: parsed.crewEpoch,
      revision: 0,
      subjectKind: parsed.subjectKind,
      delegationId: parsed.delegationId ?? null,
      attempt: parsed.attempt ?? null,
      runId: run.id,
      instanceId: run.instanceId,
      chatId: run.chatId,
      machineId: parsed.machineId,
      membershipEpoch: parsed.membershipEpoch,
      directoryRealPath: parsed.directoryRealPath,
      directoryRevision: parsed.directoryRevision,
      operationsJson: JSON.stringify(canonical.operations),
      clientRequestId: parsed.clientRequestId,
      payloadHash: hash,
      approval: "pending",
      approvedByProfileId: null,
      approvedByInstanceId: null,
      state: "queued",
      mutationId: null,
      grantId: null,
      generation: null,
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
      reason: null,
    };
    if (
      (r.subjectKind === "delegation" && (!r.delegationId || !r.attempt)) ||
      (r.subjectKind === "lead_run" && (r.delegationId || r.attempt))
    )
      fail("资源主体无效");
    const reason = eligibility(r);
    if (reason) fail(reason);
    db.insert(crewResourceRequest).values(r).run();
    event(r, "requested", "lead");
    return r;
  });
}
export function approveCrewResource(
  input: CrewResourceDecisionInput,
  actor: CrewResourceActor,
): Request {
  return atomic(() => {
    const r = read(input.resourceRequestId);
    const l = lead(r.crewChatId, input.crewEpoch, actor);
    if (r.crewEpoch !== input.crewEpoch) fail("crew_epoch_changed");
    const reason = eligibility(r);
    if (reason) fail(reason);
    if (r.approval === "approved") return r;
    if (r.revision !== input.expectedRevision || r.approval !== "pending" || r.state !== "queued")
      throw new CrewResourceError("conflict", "资源审批 revision 已改变");
    return update(
      r,
      {
        approval: "approved",
        approvedByInstanceId: l.instance.id,
        approvedByProfileId: l.instance.agentProfileId,
      },
      "approved",
    );
  });
}
function freeze(r: Request, reason: string): Request {
  if (r.state === "released" || r.state === "attention") return r;
  if (r.state === "queued")
    return update(
      r,
      { approval: "revoked", state: "released", releasedAt: new Date(), reason },
      "released",
    );
  const key = { projectId: r.projectId, machineId: r.machineId };
  const lease = ensureLease(key, new Date());
  if (
    lease.ownerKind !== "crew" ||
    lease.holderCrewChatId !== r.crewChatId ||
    lease.generation !== r.generation
  )
    return update(
      r,
      {
        approval: "revoked",
        state: "attention",
        reason: db
          .select()
          .from(remoteExecution)
          .where(
            and(
              eq(remoteExecution.projectId, r.projectId),
              eq(remoteExecution.machineId, r.machineId),
              sql`${remoteExecution.authorizationGeneration}<=${r.generation ?? 0} AND ${remoteExecution.dispatchConnectionGeneration} IS NOT NULL AND ${remoteExecution.drainedAt} IS NULL`,
            ),
          )
          .get()
          ? "drain_unconfirmed"
          : "owner_conflict",
      },
      "attention",
    );
  const now = new Date();
  const pending = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, r.projectId),
        eq(leaseMutation.machineId, r.machineId),
        eq(leaseMutation.state, "pending"),
      ),
    )
    .get();
  if (r.state === "releasing" && pending?.id === r.mutationId) return r;
  const id = pending?.id ?? newId(ID_PREFIXES.leaseMutation);
  if (!pending)
    db.insert(leaseMutation)
      .values({
        id,
        ...key,
        actorKind: "agent",
        actorId: r.instanceId,
        requestId: `crew-release:${r.id}`,
        payloadHash: createHash("sha256").update(r.id).digest("hex"),
        action: "release",
        expectedGeneration: lease.generation,
        targetInstanceId: null,
        resourceRequestId: r.id,
        targetRunId: r.runId,
        targetAttempt: r.attempt,
        crewEpoch: r.crewEpoch,
        state: "pending",
        createdAt: now,
      })
      .run();
  db.update(machineLease)
    .set({ state: "fencing", changedAt: now })
    .where(and(eq(machineLease.projectId, r.projectId), eq(machineLease.machineId, r.machineId)))
    .run();
  db.update(leaseAuthorization)
    .set({ state: "draining" })
    .where(
      and(
        eq(leaseAuthorization.projectId, r.projectId),
        eq(leaseAuthorization.machineId, r.machineId),
        eq(leaseAuthorization.generation, lease.generation),
      ),
    )
    .run();
  for (const execution of db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.projectId, r.projectId),
        eq(remoteExecution.machineId, r.machineId),
        sql`${remoteExecution.authorizationGeneration}<=${lease.generation}`,
        sql`${remoteExecution.terminalAt} IS NULL`,
      ),
    )
    .all()) {
    db.update(remoteExecution)
      .set(
        execution.dispatchConnectionGeneration === null
          ? { state: "rejected", failureReason: "authorization_revoked", terminalAt: now }
          : { state: "draining" },
      )
      .where(eq(remoteExecution.id, execution.id))
      .run();
  }
  if (r.grantId)
    db.update(leaseGrant)
      .set({ state: "revoked", revokedAt: now })
      .where(and(eq(leaseGrant.id, r.grantId), eq(leaseGrant.state, "active")))
      .run();
  return update(
    r,
    { approval: "revoked", state: "releasing", mutationId: id, reason },
    "releasing",
  );
}
export function revokeCrewResource(
  input: CrewResourceDecisionInput,
  actor: CrewResourceActor,
): Request {
  return atomic(() => {
    const r = read(input.resourceRequestId);
    lead(r.crewChatId, input.crewEpoch, actor);
    if (r.crewEpoch !== input.crewEpoch) fail("crew_epoch_changed");
    if (r.approval === "revoked") return r;
    if (r.revision !== input.expectedRevision)
      throw new CrewResourceError("conflict", "资源 revision 已改变");
    return freeze(r, "lead_revoked");
  });
}
export function releaseCrewResource(id: string, actor: CrewResourceActor): Request {
  return atomic(() => {
    const r = read(id);
    if (
      r.projectId !== actor.projectId ||
      r.runId !== actor.runId ||
      r.instanceId !== actor.instanceId
    )
      fail("只有原 run 可以归还资源");
    return freeze(r, "worker_released");
  });
}
export function freezeCrewResources(
  scope: { runId?: string; crewChatId?: string; delegationId?: string },
  reason: string,
): void {
  atomic(() => {
    for (const r of db
      .select()
      .from(crewResourceRequest)
      .where(sql`${crewResourceRequest.state} != 'released'`)
      .all()) {
      if (
        (scope.runId && r.runId === scope.runId) ||
        (scope.crewChatId && r.crewChatId === scope.crewChatId) ||
        (scope.delegationId && r.delegationId === scope.delegationId)
      )
        freeze(r, reason);
    }
  });
}
export function advanceCrewResources(): number {
  return atomic(() => {
    let count = 0;
    const queue = db
      .select()
      .from(crewResourceRequest)
      .where(
        and(
          inArray(crewResourceRequest.state, ["queued", "allocated"]),
          eq(crewResourceRequest.approval, "approved"),
        ),
      )
      .orderBy(asc(crewResourceRequest.createdAt), sql`${crewResourceRequest}.rowid`)
      .all();
    for (const r of queue) {
      const reason = eligibility(r);
      if (reason) {
        freeze(r, reason);
        continue;
      }
      const now = new Date();
      const key = { projectId: r.projectId, machineId: r.machineId };
      const lease = ensureLease(key, now);
      if (lease.state !== "free") continue;
      const occupied = db
        .select()
        .from(crewResourceRequest)
        .where(
          and(
            eq(crewResourceRequest.projectId, r.projectId),
            eq(crewResourceRequest.machineId, r.machineId),
            sql`${crewResourceRequest.id}!=${r.id}`,
            inArray(crewResourceRequest.state, [
              "allocated",
              "active",
              "releasing",
              "held",
              "attention",
            ]),
          ),
        )
        .get();
      if (occupied) continue;
      if (lease.generation >= Number.MAX_SAFE_INTEGER) continue;
      if (r.state !== "allocated") update(r, { state: "allocated" }, "allocated");
      const generation = lease.generation + 1;
      const grantId = newId(ID_PREFIXES.leaseGrant);
      const mutationId = newId(ID_PREFIXES.leaseMutation);
      db.update(leaseAuthorization)
        .set({ state: "revoked", revokedAt: now })
        .where(
          and(
            eq(leaseAuthorization.projectId, r.projectId),
            eq(leaseAuthorization.machineId, r.machineId),
            eq(leaseAuthorization.generation, lease.generation),
          ),
        )
        .run();
      db.insert(leaseAuthorization)
        .values({
          ...key,
          generation,
          holderInstanceId: r.instanceId,
          ownerKind: "crew",
          ownerCrewChatId: r.crewChatId,
          state: "active",
          reason: "acquire",
          issuedAt: now,
        })
        .run();
      db.update(machineLease)
        .set({
          generation,
          state: "held",
          holderInstanceId: null,
          ownerKind: "crew",
          holderCrewChatId: r.crewChatId,
          changedAt: now,
        })
        .where(
          and(eq(machineLease.projectId, r.projectId), eq(machineLease.machineId, r.machineId)),
        )
        .run();
      db.insert(leaseGrant)
        .values({
          id: grantId,
          ...key,
          generation,
          crewChatId: r.crewChatId,
          crewEpoch: r.crewEpoch,
          subjectKind: r.subjectKind,
          delegationId: r.delegationId,
          attempt: r.attempt,
          expiresAt: new Date(now.getTime() + 86400000),
          grantorInstanceId: r.approvedByInstanceId!,
          granteeInstanceId: r.instanceId,
          granteeRunId: r.runId,
          state: "active",
          requestId: `crew:${r.id}`,
          issuedAt: now,
        })
        .run();
      db.insert(leaseMutation)
        .values({
          id: mutationId,
          ...key,
          actorKind: "agent",
          actorId: r.instanceId,
          requestId: `crew-allocate:${r.id}`,
          payloadHash: r.payloadHash,
          action: "acquire",
          expectedGeneration: lease.generation,
          resourceRequestId: r.id,
          targetRunId: r.runId,
          targetAttempt: r.attempt,
          crewEpoch: r.crewEpoch,
          state: "completed",
          completedGeneration: generation,
          createdAt: now,
          completedAt: now,
        })
        .run();
      update(read(r.id), { state: "active", grantId, generation, mutationId }, "active");
      count++;
    }
    return count;
  });
}
export function reconcileCrewResources(now: Date = new Date()): number {
  return atomic(() => {
    let count = 0;
    for (const r of db
      .select()
      .from(crewResourceRequest)
      .where(sql`${crewResourceRequest.state} != 'released'`)
      .all()) {
      const reason = eligibility(r);
      const grant = r.grantId
        ? db.select().from(leaseGrant).where(eq(leaseGrant.id, r.grantId)).get()
        : null;
      let current = r;
      if (
        reason ||
        r.approval === "revoked" ||
        r.state === "held" ||
        (r.state === "active" && (!grant || grant.expiresAt <= now))
      )
        current = freeze(r, reason ?? "recovery");
      if (current.state === "active" && current.generation !== null) {
        const leaseNow = db
          .select()
          .from(machineLease)
          .where(
            and(
              eq(machineLease.projectId, r.projectId),
              eq(machineLease.machineId, r.machineId),
            ),
          )
          .get();
        const activeGrant = current.grantId
          ? db
              .select()
              .from(leaseGrant)
              .where(eq(leaseGrant.id, current.grantId))
              .get()
          : null;
        // 外部（例如 Human force reclaim）已经收回/替换了 lease：请求不能继续
        // 显示 active，否则会永久占槽；未确认排空仍须转 attention。
        if (
          !activeGrant ||
          activeGrant.state !== "active" ||
          !leaseNow ||
          leaseNow.state === "free" ||
          leaseNow.generation !== current.generation ||
          leaseNow.ownerKind !== "crew" ||
          leaseNow.holderCrewChatId !== current.crewChatId
        ) {
          const forced = current.mutationId
            ? db
                .select()
                .from(leaseMutation)
                .where(eq(leaseMutation.id, current.mutationId))
                .get()
            : null;
          const undrained = db
            .select()
            .from(remoteExecution)
            .where(
              and(
                eq(remoteExecution.projectId, r.projectId),
                eq(remoteExecution.machineId, r.machineId),
                sql`${remoteExecution.authorizationGeneration}<=${current.generation} AND ${remoteExecution.dispatchConnectionGeneration} IS NOT NULL AND ${remoteExecution.drainedAt} IS NULL`,
              ),
            )
            .get();
          if (undrained) {
            update(current, { state: "attention", reason: "drain_unconfirmed" }, "attention");
            count++;
          } else if (forced?.requestId.startsWith("force-reclaim:")) {
            update(current, { state: "attention", reason: "force_reclaimed" }, "attention");
            count++;
          } else {
            update(current, { state: "released", releasedAt: new Date() }, "released");
            count++;
          }
          continue;
        }
      }
      if (
        current.state === "attention" &&
        (current.reason === "owner_conflict" || current.reason === "drain_unconfirmed")
      ) {
        const leaseNow = db
          .select()
          .from(machineLease)
          .where(
            and(
              eq(machineLease.projectId, r.projectId),
              eq(machineLease.machineId, r.machineId),
            ),
          )
          .get();
        const stillOurs =
          leaseNow?.state !== "free" &&
          leaseNow?.generation === current.generation &&
          leaseNow?.ownerKind === "crew" &&
          leaseNow?.holderCrewChatId === current.crewChatId;
        if (!stillOurs) {
          const undrained = db
            .select()
            .from(remoteExecution)
            .where(
              and(
                eq(remoteExecution.projectId, r.projectId),
                eq(remoteExecution.machineId, r.machineId),
                sql`${remoteExecution.authorizationGeneration}<=${current.generation ?? 0} AND ${remoteExecution.dispatchConnectionGeneration} IS NOT NULL AND ${remoteExecution.drainedAt} IS NULL`,
              ),
            )
            .get();
          if (!undrained) {
            update(current, { state: "released", releasedAt: new Date() }, "released");
            count++;
          }
        }
        continue;
      }
      if (current.state === "releasing") {
        completeLeaseMutation({ projectId: r.projectId, machineId: r.machineId }, new Date());
        const mutation = current.mutationId
          ? db.select().from(leaseMutation).where(eq(leaseMutation.id, current.mutationId)).get()
          : null;
        if (mutation?.state === "completed") {
          const undrained = db
            .select()
            .from(remoteExecution)
            .where(
              and(
                eq(remoteExecution.projectId, r.projectId),
                eq(remoteExecution.machineId, r.machineId),
                sql`${remoteExecution.authorizationGeneration}<=${r.generation ?? mutation.expectedGeneration} AND ${remoteExecution.dispatchConnectionGeneration} IS NOT NULL AND ${remoteExecution.drainedAt} IS NULL`,
              ),
            )
            .get();
          if (undrained)
            update(current, { state: "attention", reason: "drain_unconfirmed" }, "attention");
          else {
            update(current, { state: "released", releasedAt: new Date() }, "released");
            count++;
          }
        }
      }
    }
    for (const lease of db
      .select()
      .from(machineLease)
      .where(eq(machineLease.ownerKind, "crew"))
      .all()) {
      const owned = db
        .select()
        .from(crewResourceRequest)
        .where(
          and(
            eq(crewResourceRequest.projectId, lease.projectId),
            eq(crewResourceRequest.machineId, lease.machineId),
            inArray(crewResourceRequest.state, [
              "active",
              "allocated",
              "held",
              "releasing",
              "attention",
            ]),
          ),
        )
        .get();
      if (owned) continue;
      const key = { projectId: lease.projectId, machineId: lease.machineId },
        now = new Date();
      const auth = db
        .select()
        .from(leaseAuthorization)
        .where(
          and(
            eq(leaseAuthorization.projectId, key.projectId),
            eq(leaseAuthorization.machineId, key.machineId),
            eq(leaseAuthorization.generation, lease.generation),
          ),
        )
        .get();
      if (!auth?.holderInstanceId) continue;
      let pending = db
        .select()
        .from(leaseMutation)
        .where(
          and(
            eq(leaseMutation.projectId, key.projectId),
            eq(leaseMutation.machineId, key.machineId),
            eq(leaseMutation.state, "pending"),
          ),
        )
        .get();
      if (!pending) {
        const id = newId(ID_PREFIXES.leaseMutation),
          requestId = `crew-recovery:${lease.projectId}:${lease.machineId}:${lease.generation}`;
        db.insert(leaseMutation)
          .values({
            id,
            ...key,
            actorKind: "agent",
            actorId: auth.holderInstanceId,
            requestId,
            payloadHash: createHash("sha256").update(requestId).digest("hex"),
            action: "release",
            expectedGeneration: lease.generation,
            state: "pending",
            createdAt: now,
          })
          .run();
      }
      db.update(machineLease)
        .set({ state: "fencing", changedAt: now })
        .where(
          and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
        )
        .run();
      db.update(leaseAuthorization)
        .set({ state: "draining" })
        .where(
          and(
            eq(leaseAuthorization.projectId, key.projectId),
            eq(leaseAuthorization.machineId, key.machineId),
            eq(leaseAuthorization.generation, lease.generation),
          ),
        )
        .run();
      db.update(leaseGrant)
        .set({ state: "revoked", revokedAt: now })
        .where(
          and(
            eq(leaseGrant.projectId, key.projectId),
            eq(leaseGrant.machineId, key.machineId),
            eq(leaseGrant.state, "active"),
          ),
        )
        .run();
      db.update(remoteExecution)
        .set({ state: "draining" })
        .where(
          and(
            eq(remoteExecution.projectId, key.projectId),
            eq(remoteExecution.machineId, key.machineId),
            sql`${remoteExecution.dispatchConnectionGeneration} IS NOT NULL AND ${remoteExecution.drainedAt} IS NULL AND ${remoteExecution.terminalAt} IS NULL`,
          ),
        )
        .run();
      completeLeaseMutation(key, now);
    }
    return count;
  });
}
export function crewResourcesReady(runId: string, now: Date = new Date()): boolean {
  const requests = db
    .select()
    .from(crewResourceRequest)
    .where(eq(crewResourceRequest.runId, runId))
    .all();
  if (requests.length === 0) return true;
  // released 是历史：lead 撤销后为同一 run 重新申请时，旧行不能继续阻塞 admission。
  const current = requests.filter(
    (r: Request) => r.state !== "released" && r.approval !== "revoked",
  );
  if (current.length === 0) return false;
  return current.every(
    (r: Request) =>
      r.state === "active" &&
      r.approval === "approved" &&
      eligibility(r) === null &&
      !!db
        .select()
        .from(machineLease)
        .where(
          and(
            eq(machineLease.projectId, r.projectId),
            eq(machineLease.machineId, r.machineId),
            eq(machineLease.ownerKind, "crew"),
            eq(machineLease.holderCrewChatId, r.crewChatId),
            eq(machineLease.generation, r.generation ?? -1),
            eq(machineLease.state, "held"),
          ),
        )
        .get() &&
      !!db
        .select()
        .from(leaseAuthorization)
        .where(
          and(
            eq(leaseAuthorization.projectId, r.projectId),
            eq(leaseAuthorization.machineId, r.machineId),
            eq(leaseAuthorization.generation, r.generation ?? -1),
            eq(leaseAuthorization.state, "active"),
            eq(leaseAuthorization.holderInstanceId, r.instanceId),
          ),
        )
        .get() &&
      !!r.grantId &&
      (db
        .select()
        .from(leaseGrant)
        .where(and(eq(leaseGrant.id, r.grantId), eq(leaseGrant.state, "active")))
        .get()
        ?.expiresAt.getTime() ?? 0) > now.getTime(),
  );
}
export function hasCrewResourceGate(runId: string): boolean {
  const rows: Request[] = db
    .select()
    .from(crewResourceRequest)
    .where(eq(crewResourceRequest.runId, runId))
    .all()
    .filter((r: Request) => r.state !== "released" && r.approval !== "revoked");
  return (
    rows.length > 0 &&
    rows.every(
      (r) =>
        ["queued", "allocated", "active"].includes(r.state) &&
        r.approval !== "revoked" &&
        eligibility(r) === null,
    )
  );
}
export function deliverCrewResourceEvents(): number {
  return atomic(() => {
    let count = 0;
    for (const e of db
      .select()
      .from(crewResourceEvent)
      .where(eq(crewResourceEvent.state, "bound"))
      .all()) {
      const input =
        e.boundRunId && e.messageId
          ? db
              .select()
              .from(agentRunInput)
              .where(
                and(
                  eq(agentRunInput.runId, e.boundRunId),
                  eq(agentRunInput.messageId, e.messageId),
                ),
              )
              .get()
          : null;
      if (input?.disposition === "delivered")
        db.update(crewResourceEvent)
          .set({ state: "acked" })
          .where(eq(crewResourceEvent.id, e.id))
          .run();
      else if (input?.disposition === "cancelled")
        db.update(crewResourceEvent)
          .set({ state: "attention", attentionReason: "input_cancelled" })
          .where(eq(crewResourceEvent.id, e.id))
          .run();
    }
    for (const e of db
      .select()
      .from(crewResourceEvent)
      .where(eq(crewResourceEvent.state, "pending"))
      .all()) {
      const r = read(e.requestId);
      if (e.audience === "human") {
        db.update(crewResourceEvent)
          .set({ state: "attention", attentionReason: r.reason ?? "human_required" })
          .where(eq(crewResourceEvent.id, e.id))
          .run();
        continue;
      }
      if (
        e.audience === "lead" &&
        (r.approval !== "pending" || r.state !== "queued" || r.subjectKind === "lead_run")
      ) {
        db.update(crewResourceEvent)
          .set({ state: "acked" })
          .where(eq(crewResourceEvent.id, e.id))
          .run();
        continue;
      }
      const crew = db.select().from(chat).where(eq(chat.id, r.crewChatId)).get();
      if (!crew || crew.crewEpoch !== e.crewEpoch) {
        db.update(crewResourceEvent)
          .set({ state: "attention", attentionReason: "epoch_changed" })
          .where(eq(crewResourceEvent.id, e.id))
          .run();
        continue;
      }
      // Only requests need the lead's decision; subsequent queue transitions do not wake it again.
      let runId = r.runId,
        chatId = r.chatId;
      const messageId = newId(ID_PREFIXES.message);
      const sender = r.approvedByProfileId ?? crew.leadProfileId;
      if (!sender) continue;
      if (e.audience === "lead") {
        const owner = db.select().from(project).where(eq(project.id, r.projectId)).get();
        if (!owner || !crew.leadProfileId) continue;
        chatId = crew.id;
        const instance = ensureInstance(chatId, crew.leadProfileId, {
          userId: owner.createdBy,
          requestId: newId(ID_PREFIXES.request),
        });
        db.insert(message)
          .values({
            id: messageId,
            chatId: r.chatId,
            delegationId: r.delegationId,
            delegationPromptForChatId: crew.id,
            senderKind: "agent",
            senderId: sender,
            body: JSON.stringify({
              resourceRequestId: r.id,
              revision: r.revision,
              kind: e.kind,
              ...JSON.parse(e.payloadJson),
            }),
          })
          .run();
        runId = attachDelegationInput(messageId, chatId, instance.id, r.projectId);
      } else {
        const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
        if (!run || !["queued", "running"].includes(run.status)) {
          db.update(crewResourceEvent)
            .set({ state: "attention", attentionReason: "original_run_terminal" })
            .where(eq(crewResourceEvent.id, e.id))
            .run();
          continue;
        }
        db.insert(message)
          .values({
            id: messageId,
            chatId,
            senderKind: "agent",
            senderId: sender,
            body: JSON.stringify({
              resourceRequestId: r.id,
              revision: e.revision,
              kind: e.kind,
              ...JSON.parse(e.payloadJson),
            }),
          })
          .run();
        db.insert(agentRunInput).values({ runId, messageId }).run();
      }
      db.update(crewResourceEvent)
        .set({ state: "bound", messageId, boundRunId: runId })
        .where(eq(crewResourceEvent.id, e.id))
        .run();
      count++;
    }
    return count;
  });
}
export function hasCrewResourceResponsibilities(crewId: string, profileId: string): boolean {
  const crew = db.select().from(chat).where(eq(chat.id, crewId)).get();
  return db
    .select()
    .from(crewResourceRequest)
    .where(
      and(
        eq(crewResourceRequest.crewChatId, crewId),
        sql`${crewResourceRequest.state}!='released'`,
      ),
    )
    .all()
    .some(
      (r: Request) =>
        crew?.leadProfileId === profileId ||
        db
          .select()
          .from(agentInstance)
          .where(
            and(eq(agentInstance.id, r.instanceId), eq(agentInstance.agentProfileId, profileId)),
          )
          .get(),
    );
}
export function assertCrewExecutionScope(
  key: { projectId: string; machineId: string },
  generation: number,
  actor: { instanceId?: string; runId?: string },
  operation?: { kind: string; cwd?: string; path?: string },
  directoryRevision?: number | null,
  now: Date = new Date(),
): void {
  const lease = db
    .select()
    .from(machineLease)
    .where(
      and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
    )
    .get();
  if (lease?.ownerKind !== "crew") return;
  const grant = db
    .select()
    .from(leaseGrant)
    .where(
      and(
        eq(leaseGrant.projectId, key.projectId),
        eq(leaseGrant.machineId, key.machineId),
        eq(leaseGrant.generation, generation),
        eq(leaseGrant.state, "active"),
      ),
    )
    .get();
  if (
    !grant ||
    grant.granteeRunId !== actor.runId ||
    grant.granteeInstanceId !== actor.instanceId ||
    grant.crewChatId !== lease.holderCrewChatId ||
    grant.expiresAt <= now
  )
    fail("Crew grant 不匹配原 run");
  const r = db
    .select()
    .from(crewResourceRequest)
    .where(eq(crewResourceRequest.grantId, grant.id))
    .get();
  if (
    !r ||
    r.state !== "active" ||
    r.approval !== "approved" ||
    r.crewEpoch !== grant.crewEpoch ||
    r.runId !== grant.granteeRunId ||
    r.instanceId !== grant.granteeInstanceId ||
    r.crewChatId !== grant.crewChatId ||
    r.subjectKind !== grant.subjectKind ||
    r.delegationId !== grant.delegationId ||
    r.generation !== grant.generation ||
    r.attempt !== grant.attempt ||
    eligibility(r)
  )
    fail("Crew 授权已冻结");
  if (operation) {
    if (
      !JSON.parse(r.operationsJson).includes(operation.kind) ||
      (directoryRevision != null && directoryRevision !== r.directoryRevision)
    )
      fail("操作或目录 revision 超出批准范围");
    const path = operation.path ?? operation.cwd ?? r.directoryRealPath;
    const normalized = posix.normalize(path);
    const root = posix.normalize(r.directoryRealPath).replace(/\/$/, "") || "/";
    if (normalized !== root && !normalized.startsWith(root === "/" ? "/" : root + "/"))
      fail("目录超出批准范围");
  }
}
