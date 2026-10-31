import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentRun, leaseMutation, turnContext } from "../db/schema";
import { INFO_HUB_LIMITS } from "../contracts/info-hub";
import {
  turnContextReadInputSchema,
  turnContextRecordSchema,
  turnContextPromptInputSchema,
  turnContextSubmissionReceiptSchema,
  turnContextConfirmedSubmissionSchema,
  type TurnContextReadInput,
  type TurnContextRecord,
  type TurnContextReadResult,
  type TurnContextPromptInput,
  type TurnContextSubmissionReceipt,
} from "../contracts/turn-context";
import { assertProjectAccess, readRunScope, type ProjectContext } from "./access";
import { getChatInfo, getProjectInfoHub, getInfoHub, InfoHubError } from "./info-hub";
import { getRunRepoBasis, getProjectRepoState } from "./repository";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function scopeFor(input: TurnContextReadInput, ctx: ProjectContext, host = false) {
  if (host && ctx.agent) throw new InfoHubError("forbidden");
  assertProjectAccess(ctx, input.projectId);
  const scope = readRunScope(input.runId);
  if (
    !scope ||
    scope.projectId !== input.projectId ||
    (ctx.agent &&
      (ctx.agent.runId !== input.runId ||
        ctx.agent.instanceId !== scope.instanceId ||
        ctx.agent.agentProfileId !== scope.agentProfileId))
  )
    throw new InfoHubError("not_found");
  return scope;
}
function stored(input: TurnContextReadInput): TurnContextRecord | undefined {
  const row = db
    .select()
    .from(turnContext)
    .where(and(eq(turnContext.runId, input.runId), eq(turnContext.projectId, input.projectId)))
    .get();
  if (!row) return;
  const record = turnContextRecordSchema.parse({
    ...row.record,
    serializedText: row.serializedText,
    contentHash: row.contentHash,
    basisRevision: row.basisRevision,
    capturedAt: row.capturedAt.toISOString(),
    deliveryState: row.deliveryState,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    failureCode: row.failureCode,
    injectedIntoPrompt: row.deliveryState === "submitted",
  });
  if (digest(record.serializedText) !== record.contentHash)
    throw new InfoHubError("turn_context_unavailable");
  return record;
}
export function readTurnContext(
  raw: TurnContextReadInput,
  ctx: ProjectContext,
): TurnContextReadResult {
  if (ctx.agent) throw new InfoHubError("forbidden");
  const input = turnContextReadInputSchema.parse(raw);
  scopeFor(input, ctx);
  const record = stored(input);
  return record ? { kind: "captured", record } : { kind: "not_captured", ...input };
}
/** Capturing again returns the original run snapshot, including after a process restart. */
export function captureTurnContext(
  raw: TurnContextReadInput,
  ctx: ProjectContext,
): TurnContextRecord {
  const input = turnContextReadInputSchema.parse(raw);
  return db.transaction(() => {
    const scope = scopeFor(input, ctx, true);
    const existing = stored(input);
    if (existing) return existing;
    if (!scope.active) throw new InfoHubError("turn_context_unavailable");
    const hub = getProjectInfoHub(input.projectId, ctx);
    const chat = getChatInfo(scope.chatId, ctx);
    const summary = hub.chats.find((chat) => chat.chatId === scope.chatId)!;
    const agent = hub.agents.agents.find((agent) => agent.agentProfileId === scope.agentProfileId);
    const run = hub.agents.runs.active.find((run) => run.runId === input.runId);
    if (!agent || !run) throw new InfoHubError("turn_context_unavailable");
    const basis = getRunRepoBasis(input.runId, ctx);
    const checkout = basis ? null : getProjectRepoState(input.projectId, ctx).checkout;
    const workspace = basis
      ? {
          basis: "run_provenance" as const,
          path: basis.path,
          source: basis.source,
          sourceKind: basis.sourceKind,
          ref: basis.ref,
          commit: basis.commit,
          fresh: basis.fresh,
          recordedAt: basis.recordedAt,
          ...(basis.fetchedAt ? { fetchedAt: basis.fetchedAt } : {}),
        }
      : checkout
        ? {
            basis: "project_checkout" as const,
            path: checkout.path,
            source: checkout.source,
            sourceKind: checkout.sourceKind,
            ref: checkout.ref,
            commit: checkout.commit,
            recordedAt: checkout.resolvedAt,
            ...(checkout.fetchedAt ? { fetchedAt: checkout.fetchedAt } : {}),
          }
        : null;
    const pending = (
      db
        .select()
        .from(leaseMutation)
        .where(
          and(eq(leaseMutation.projectId, input.projectId), eq(leaseMutation.state, "pending")),
        )
        .all() as (typeof leaseMutation.$inferSelect)[]
    )
      .filter((row) =>
        hub.leases.items.some(
          (lease) =>
            lease.machineId === row.machineId && lease.holderInstanceId === scope.instanceId,
        ),
      )
      .filter(
        (row) => row.action === "release" || row.action === "handoff" || row.action === "reclaim",
      );
    const record: TurnContextRecord = {
      schemaVersion: 1,
      ...input,
      capturedAt: new Date().toISOString(),
      basisRevision: getInfoHub(
        input.projectId,
        { view: "agent", agentProfileId: scope.agentProfileId, section: "summary", limit: 25 },
        ctx,
      ).revision,
      serializedText: "pending",
      contentHash: "0".repeat(64),
      deliveryState: "prepared",
      submittedAt: null,
      failureCode: null,
      injectedIntoPrompt: false,
      truncated: false,
      omittedCounts: { members: 0, runs: 0, tasks: 0, leases: 0, pendingLeaseRequests: 0 },
      chatId: scope.chatId,
      instanceId: scope.instanceId,
      agentProfileId: scope.agentProfileId,
      profileName: agent.name,
      projectName: hub.projectName,
      chatTitle: summary.displayTitle,
      chatKind: chat.kind,
      chatArchived: chat.archived,
      owner: chat.owner,
      ...(summary.automation ? { automation: summary.automation } : {}),
      members: chat.members.sort((a, b) => a.memberId.localeCompare(b.memberId)),
      status: agent.status,
      heldMachines: hub.machines.filter(
        (machine) => machine.lease.holderInstanceId === scope.instanceId,
      ),
      pendingLeaseRequests: pending.map((row) => ({
        projectId: row.projectId,
        machineId: row.machineId,
        mutationId: row.id,
        action: row.action as "release" | "handoff" | "reclaim",
        state: "pending" as const,
        createdAt: row.createdAt.toISOString(),
      })),
      taskCounts: hub.tasks.counts,
      projectSummary: {
        agentCount: hub.agents.agents.length,
        chatCount: hub.chats.length,
        machineCount: hub.machines.length,
      },
      chatRuns: hub.agents.runs.active
        .filter((run) => run.chatId === scope.chatId)
        .map((run) => ({
          runId: run.runId,
          chatId: run.chatId,
          instanceId: run.instanceId,
          agentProfileId: run.agentProfileId,
          status: run.status as "queued" | "running",
          isSelf: run.runId === input.runId,
        }))
        .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.runId.localeCompare(b.runId)),
      tasks: hub.tasks.items
        .filter((task) => task.chatId === scope.chatId)
        .sort((a, b) => a.taskId.localeCompare(b.taskId))
        .map((task) => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          revision: task.revision,
          ...(task.responsibility ? { responsibility: task.responsibility } : {}),
        })),
      hostEnabled: hub.agents.runs.hostEnabled,
      workspace,
      activeRun: {
        runId: run.runId,
        status: run.status as "queued" | "running",
        pendingInputs: run.pendingInputs,
      },
    };
    const groups = [
      {
        kind: "tasks" as const,
        items: record.tasks,
        query: { view: "chat", chatId: scope.chatId, section: "tasks" },
      },
      {
        kind: "members" as const,
        items: record.members,
        query: { view: "chat", chatId: scope.chatId, section: "members" },
      },
      {
        kind: "runs" as const,
        items: record.chatRuns,
        query: { view: "chat", chatId: scope.chatId, section: "runs" },
      },
      {
        kind: "pendingLeaseRequests" as const,
        items: record.pendingLeaseRequests,
        query: { view: "agent", agentProfileId: scope.agentProfileId, section: "machines" },
      },
      {
        kind: "leases" as const,
        items: record.heldMachines,
        query: { view: "agent", agentProfileId: scope.agentProfileId, section: "machines" },
      },
    ];
    const totals = new Map(groups.map((group) => [group.kind, group.items.length]));
    const serialize = () => {
      const {
        serializedText: _text,
        contentHash: _hash,
        deliveryState: _state,
        submittedAt: _at,
        failureCode: _failure,
        injectedIntoPrompt: _injected,
        ...facts
      } = record;
      return JSON.stringify({
        channel: "sprout_turn_context",
        ...facts,
        sections: Object.fromEntries(
          groups.map((group) => [
            group.kind,
            {
              total: totals.get(group.kind),
              returned: group.items.length,
              omitted: record.omittedCounts[group.kind],
              truncated: record.omittedCounts[group.kind] > 0,
              nextQuery: { ...group.query, limit: INFO_HUB_LIMITS.defaultPageSize },
            },
          ]),
        ),
      });
    };
    let text = serialize();
    while (Buffer.byteLength(text) > INFO_HUB_LIMITS.maxTurnContextBytes) {
      const group = groups.find((group) => group.items.length > (group.kind === "runs" ? 1 : 0));
      if (!group) throw new InfoHubError("turn_context_unavailable");
      group.items.pop();
      record.omittedCounts[group.kind]++;
      record.truncated = true;
      text = serialize();
    }
    record.serializedText = text;
    record.contentHash = digest(text);
    const parsed = turnContextRecordSchema.parse(record);
    db.insert(turnContext)
      .values({
        runId: input.runId,
        projectId: input.projectId,
        instanceId: scope.instanceId,
        serializedText: text,
        contentHash: record.contentHash,
        basisRevision: record.basisRevision,
        capturedAt: new Date(record.capturedAt),
        record: parsed,
        deliveryState: "prepared",
      })
      .run();
    return parsed;
  });
}
export function prepareTurnContext(
  raw: TurnContextReadInput,
  ctx: ProjectContext,
): TurnContextPromptInput {
  const input = turnContextReadInputSchema.parse(raw);
  const scope = scopeFor(input, ctx, true);
  const record = stored(input);
  if (!scope.active || !record || record.deliveryState !== "prepared")
    throw new InfoHubError("turn_context_unavailable");
  return turnContextPromptInputSchema.parse({
    runId: record.runId,
    contentHash: record.contentHash,
    serializedText: record.serializedText,
  });
}
export function confirmTurnContext(
  raw: TurnContextSubmissionReceipt,
  ctx: ProjectContext,
): TurnContextRecord {
  const receipt = turnContextSubmissionReceiptSchema.parse(raw);
  return db.transaction(() => {
    const run = db.select().from(agentRun).where(eq(agentRun.id, receipt.runId)).get();
    if (!run) throw new InfoHubError("turn_context_unavailable");
    const input = { projectId: run.projectId, runId: run.id };
    const scope = scopeFor(input, ctx, true);
    const record = stored(input);
    if (
      !scope.active ||
      !record ||
      record.contentHash !== receipt.contentHash ||
      record.deliveryState === "failed"
    )
      throw new InfoHubError("turn_context_unavailable");
    const submitted = turnContextConfirmedSubmissionSchema.safeParse({
      record: {
        ...record,
        deliveryState: "submitted",
        submittedAt: receipt.submittedAt,
        injectedIntoPrompt: true,
      },
      receipt,
    });
    if (
      !submitted.success ||
      (record.deliveryState === "submitted" && record.submittedAt !== receipt.submittedAt)
    )
      throw new InfoHubError("turn_context_unavailable");
    db.update(turnContext)
      .set({ deliveryState: "submitted", submittedAt: new Date(receipt.submittedAt) })
      .where(eq(turnContext.runId, receipt.runId))
      .run();
    return submitted.data.record;
  });
}
