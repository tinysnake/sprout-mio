import { captureFeishuMessage } from "./feishu-delivery";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  assistantInterest,
  assistantEvent,
  assistantWatchSummary,
  assistantProposal,
  assistantWatch,
  assistantPreferences,
  chat,
  chatEffectiveMember,
  message,
  project,
  projectMember,
} from "../db/schema";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { assistantInputContextSchema } from "../contracts/assistant";
import { PUBLIC_CHANNEL_DISPLAY_TITLE } from "../contracts/chat";
import { readAssistantNativeFacts } from "./assistant-native-facts";
import type { AssistantCall, AssistantFact, AssistantTarget } from "../contracts/assistant";
import { assertProjectAccess, ProjectAccessError, type ProjectContext } from "./access";
import { getChat, ensureInstance, ChatError } from "./chat";
import { allocateContinuationRun } from "./agent-run";
import { resolveAutomationTarget } from "./automation-target";
import {
  enrollAssistantInterest,
  rescheduleWatch,
  stopAssistantWatch,
  resolveWatchIntents,
} from "./assistant-interest";

export class AssistantError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict",
    message = "Assistant 操作不可用",
  ) {
    super(message);
  }
}
const id = () => newId(ID_PREFIXES.message);
export function assistantSource(chatId: string, ctx: ProjectContext) {
  if (ctx.agent) throw new AssistantError("forbidden");
  const current = getChat(chatId, ctx);
  if (
    current.kind !== "dm" ||
    current.archivedAt ||
    current.owner.kind !== "human" ||
    current.owner.id !== ctx.userId
  )
    throw new AssistantError("not_found");
  const profile = db
    .select({ profile: agentProfile })
    .from(chatEffectiveMember)
    .innerJoin(agentProfile, eq(agentProfile.id, chatEffectiveMember.memberId))
    .innerJoin(
      projectMember,
      and(
        eq(projectMember.projectId, current.projectId),
        eq(projectMember.agentProfileId, agentProfile.id),
      ),
    )
    .where(
      and(
        eq(chatEffectiveMember.chatId, chatId),
        eq(chatEffectiveMember.memberKind, "agent"),
        eq(agentProfile.purpose, "assistant"),
        eq(agentProfile.createdBy, ctx.userId),
      ),
    )
    .get()?.profile;
  if (!profile) throw new AssistantError("not_found");
  return { current, profile };
}
export function assistantPrincipal(runId: string, userId: string, requestId: string) {
  const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  const instance =
    run && db.select().from(agentInstance).where(eq(agentInstance.id, run.instanceId)).get();
  if (
    !run ||
    !instance ||
    run.status !== "running" ||
    instance.chatId !== run.chatId ||
    instance.projectId !== run.projectId
  )
    throw new AssistantError("not_found");
  const ctx = { userId, requestId };
  const source = assistantSource(run.chatId, ctx);
  if (source.profile.id !== instance.agentProfileId || source.current.projectId !== run.projectId)
    throw new AssistantError("not_found");
  return { ...source, run, ctx };
}
function visibleTarget(projectId: string, chatId: string, ctx: ProjectContext) {
  assertProjectAccess(ctx, projectId);
  const target = getChat(chatId, ctx);
  if (target.projectId !== projectId || target.archivedAt) throw new AssistantError("not_found");
  return target;
}
function resolvedTarget(target: AssistantTarget, ctx: ProjectContext) {
  const resolved = resolveAutomationTarget(target.projectId, target, ctx);
  if ("reason" in resolved)
    throw new AssistantError("conflict", `工作目标不可用：${resolved.reason}`);
  return { ...resolved, instance: ensureInstance(resolved.chatId, resolved.agentProfileId, ctx) };
}
function operationHash(
  target: AssistantTarget,
  agentProfileId: string,
  instanceId: string,
  body: string,
) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, target, agentProfileId, instanceId, body }))
    .digest("hex");
}
export function captureAssistantFact(
  assistantChatId: string,
  eventKey: string,
  fact: AssistantFact,
  now: Date,
) {
  return sqlite
    .transaction(() => {
      db.insert(assistantEvent)
        .values({ id: id(), assistantChatId, eventKey, fact, createdAt: now })
        .onConflictDoNothing()
        .run();
      const event = db
        .select()
        .from(assistantEvent)
        .where(
          and(
            eq(assistantEvent.assistantChatId, assistantChatId),
            eq(assistantEvent.eventKey, eventKey),
          ),
        )
        .get()!;
      if (event.fact.watchWindow)
        db.insert(assistantWatchSummary)
          .values({
            eventId: event.id,
            nextAttemptAt: now,
          })
          .onConflictDoNothing()
          .run();
      return event;
    })
    .immediate();
}
export function prepareAssistantSteerContext(
  runId: string,
  messageId: string,
  ctx: ProjectContext,
  now = new Date(),
) {
  return sqlite
    .transaction(() => {
      const source = assistantPrincipal(runId, ctx.userId, ctx.requestId);
      const input = db
        .select({ input: agentRunInput, message })
        .from(agentRunInput)
        .innerJoin(message, eq(message.id, agentRunInput.messageId))
        .where(
          and(
            eq(agentRunInput.runId, runId),
            eq(agentRunInput.messageId, messageId),
            eq(agentRunInput.disposition, "pending"),
          ),
        )
        .get();
      if (
        !input ||
        input.message.chatId !== source.current.id ||
        input.message.senderKind !== "human" ||
        input.message.senderId !== ctx.userId
      )
        throw new AssistantError("forbidden");
      if (input.input.assistantContext)
        return assistantInputContextSchema.parse(input.input.assistantContext);
      const facts = readAssistantNativeFacts(source.current.id, source.ctx);
      const envelope = {
        channel: "sprout_assistant_native",
        runId,
        messageId,
        capturedAt: now.toISOString(),
        facts,
        truncated: false,
      };
      let serializedText = JSON.stringify(envelope);
      while (Buffer.byteLength(serializedText, "utf8") > 8192 && facts.length) {
        facts.shift();
        envelope.truncated = true;
        serializedText = JSON.stringify(envelope);
      }
      const context = assistantInputContextSchema.parse({
        runId,
        messageId,
        serializedText,
        contentHash: createHash("sha256").update(serializedText).digest("hex"),
      });
      db.update(agentRunInput)
        .set({ assistantContext: context })
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .run();
      return context;
    })
    .immediate();
}

export function createAssistantProposal(
  source: ReturnType<typeof assistantPrincipal>,
  requestedTarget: AssistantTarget,
  body: string,
  now = new Date(),
) {
  return sqlite
    .transaction(() => {
      assistantPrincipal(source.run.id, source.ctx.userId, source.ctx.requestId);
      const resolved = resolvedTarget(requestedTarget, source.ctx);
      const target = { ...requestedTarget, chatId: resolved.chatId };
      const proposalId = id();
      db.insert(assistantProposal)
        .values({
          id: proposalId,
          assistantChatId: source.current.id,
          sourceRunId: source.run.id,
          humanId: source.ctx.userId,
          target,
          targetProjectId: target.projectId,
          targetChatId: target.chatId,
          agentProfileId: resolved.agentProfileId,
          instanceId: resolved.instance.id,
          body,
          operationHash: operationHash(target, resolved.agentProfileId, resolved.instance.id, body),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86400000),
        })
        .run();
      captureAssistantFact(
        source.current.id,
        `proposal:${proposalId}`,
        {
          kind: "decision",
          proposalId,
          targetProjectId: target.projectId,
          targetChatId: target.chatId,
          body: `待确认工作 · ${resolved.agentProfileId}\n${body}`,
          sampledAt: now.toISOString(),
        },
        now,
      );
      deliverAssistantEvents(now);
      return {
        proposalId,
        status: "pending" as const,
        target,
        agentProfileId: resolved.agentProfileId,
        body,
      };
    })
    .immediate();
}
function proposalAccess(proposalId: string, assistantChatId: string, ctx: ProjectContext) {
  assistantSource(assistantChatId, ctx);
  const row = db
    .select()
    .from(assistantProposal)
    .where(
      and(
        eq(assistantProposal.id, proposalId),
        eq(assistantProposal.assistantChatId, assistantChatId),
        eq(assistantProposal.humanId, ctx.userId),
      ),
    )
    .get();
  if (!row) throw new AssistantError("not_found");
  visibleTarget(row.targetProjectId, row.targetChatId, ctx);
  return row;
}
function currentProposalTarget(row: typeof assistantProposal.$inferSelect, ctx: ProjectContext) {
  const current = resolvedTarget(row.target, ctx);
  if (
    current.agentProfileId !== row.agentProfileId ||
    current.instance.id !== row.instanceId ||
    operationHash(row.target, row.agentProfileId, row.instanceId, row.body) !== row.operationHash
  )
    throw new AssistantError("conflict", "目标已改变，请重新提案");
  return current;
}
export function assertAssistantProposalCurrent(
  proposalId: string,
  assistantChatId: string,
  ctx: ProjectContext,
) {
  const row = proposalAccess(proposalId, assistantChatId, ctx);
  currentProposalTarget(row, ctx);
  return row;
}
export function confirmAssistantProposal(
  proposalId: string,
  assistantChatId: string,
  ctx: ProjectContext,
  now = new Date(),
) {
  return sqlite
    .transaction(() => {
      const row = proposalAccess(proposalId, assistantChatId, ctx);
      currentProposalTarget(row, ctx);
      if (row.status === "submitted")
        return { proposalId, messageId: row.workMessageId!, status: row.status };
      if (row.status !== "pending" || row.expiresAt <= now)
        throw new AssistantError("conflict", "提案已失效");
      const target = currentProposalTarget(row, ctx);
      const messageId = id();
      db.update(assistantProposal)
        .set({
          status: "submitted",
          confirmedBy: ctx.userId,
          confirmedAt: now,
          workMessageId: messageId,
        })
        .where(eq(assistantProposal.id, row.id))
        .run();
      db.insert(message)
        .values({
          id: messageId,
          chatId: row.targetChatId,
          senderKind: "assistant_work",
          senderId: row.id,
          assistantProposalId: row.id,
          body: row.body,
          createdAt: now,
        })
        .run();
      const run = allocateContinuationRun(
        {
          instanceId: target.instance.id,
          chatId: row.targetChatId,
          projectId: row.targetProjectId,
        },
        ctx.requestId,
        now,
      );
      db.insert(agentRunInput).values({ runId: run.id, messageId, disposition: "pending" }).run();
      captureAssistantFact(
        row.assistantChatId,
        `proposal:${row.id}:confirmed`,
        {
          kind: "decision",
          proposalId: row.id,
          targetProjectId: row.targetProjectId,
          targetChatId: row.targetChatId,
          sampledAt: now.toISOString(),
          body: `Human 已确认提案 ${row.id}，已创建工作输入 ${messageId}；等待工作 Agent 实际接收。\n${row.body}`,
        },
        now,
      );
      deliverAssistantEvents(now);
      return { proposalId, messageId, status: "submitted" as const };
    })
    .immediate();
}
export function revokeAssistantProposal(
  proposalId: string,
  assistantChatId: string,
  ctx: ProjectContext,
) {
  return sqlite
    .transaction(() => {
      const row = proposalAccess(proposalId, assistantChatId, ctx);
      const status =
        row.status === "pending" ? "rejected" : row.status === "submitted" ? "revoked" : row.status;
      db.update(assistantProposal).set({ status }).where(eq(assistantProposal.id, row.id)).run();
      captureAssistantFact(
        row.assistantChatId,
        `proposal:${row.id}:${status}`,
        {
          kind: "decision",
          proposalId: row.id,
          targetProjectId: row.targetProjectId,
          targetChatId: row.targetChatId,
          sampledAt: new Date().toISOString(),
          body:
            status === "rejected"
              ? `Human 已拒绝提案 ${row.id}。`
              : `Human 已撤销提案 ${row.id} 的未投递输入；已接收的工作不会被撤回。`,
        },
        new Date(),
      );
      deliverAssistantEvents(new Date());
      return { proposalId };
    })
    .immediate();
}
function validAssistantInput(runId: string, messageId: string) {
  const input = db
    .select()
    .from(agentRunInput)
    .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
    .get();
  const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  const saved = db.select().from(message).where(eq(message.id, messageId)).get();
  const proposal =
    saved?.assistantProposalId &&
    db
      .select()
      .from(assistantProposal)
      .where(eq(assistantProposal.id, saved.assistantProposalId))
      .get();
  if (
    !input ||
    input.disposition !== "pending" ||
    input.admittedAt ||
    !run ||
    !proposal ||
    saved?.senderKind !== "assistant_work"
  )
    return;
  try {
    const ctx = { userId: proposal.humanId, requestId: run.requestId };
    proposalAccess(proposal.id, proposal.assistantChatId, ctx);
    currentProposalTarget(proposal, ctx);
    if (
      proposal.status !== "submitted" ||
      proposal.confirmedBy !== proposal.humanId ||
      !proposal.confirmedAt ||
      proposal.workMessageId !== saved.id ||
      proposal.instanceId !== run.instanceId ||
      proposal.targetProjectId !== run.projectId ||
      proposal.targetChatId !== run.chatId ||
      saved.chatId !== run.chatId ||
      !["running", "queued"].includes(run.status)
    )
      return;
    return proposal;
  } catch (error) {
    if (
      error instanceof AssistantError ||
      error instanceof ProjectAccessError ||
      error instanceof ChatError
    )
      return;
    throw error;
  }
}
export function cancelInvalidAssistantInputs(runId: string) {
  sqlite
    .transaction(() => {
      const inputs = db
        .select({ messageId: agentRunInput.messageId })
        .from(agentRunInput)
        .innerJoin(message, eq(message.id, agentRunInput.messageId))
        .where(
          and(
            eq(agentRunInput.runId, runId),
            eq(agentRunInput.disposition, "pending"),
            isNull(agentRunInput.admittedAt),
            eq(message.senderKind, "assistant_work"),
          ),
        )
        .all();
      for (const input of inputs)
        if (!validAssistantInput(runId, input.messageId))
          db.update(agentRunInput)
            .set({
              disposition: "cancelled",
              cancelledAt: new Date(),
              cancelReason: "assistant_context_changed",
            })
            .where(
              and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, input.messageId)),
            )
            .run();
    })
    .immediate();
}
export function admitAssistantInput<T>(
  runId: string,
  messageId: string,
  send: () => T,
): T | undefined {
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  sqlite
    .transaction(() => {
      const proposal = validAssistantInput(runId, messageId);
      if (!proposal) {
        cancelInvalidAssistantInputs(runId);
        return;
      }
      db.update(agentRunInput)
        .set({ admittedAt: new Date() })
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .run();
      enrollAssistantInterest(proposal.assistantChatId, runId, "proposal", proposal.id, new Date());
      try {
        result = send();
      } catch (error) {
        failure = { error };
      }
    })
    .immediate();
  if (failure) throw failure.error;
  return result;
}
export function dispatchAssistantCall(
  runId: string,
  userId: string,
  requestId: string,
  call: AssistantCall,
  liveActivity: (runId: string) => unknown,
) {
  const source = assistantPrincipal(runId, userId, requestId);
  switch (call.type) {
    case "assistant_propose":
      return createAssistantProposal(source, call.input.target, call.input.body);
    case "assistant_watch": {
      const now = new Date();
      if (call.input.active === false)
        return stopAssistantWatch(
          source.current.id,
          call.input.targetProjectId,
          call.input.chatId,
          source.ctx.userId,
          now,
        );
      visibleTarget(call.input.targetProjectId, call.input.chatId, source.ctx);
      const current = db
        .select()
        .from(assistantWatch)
        .where(
          and(
            eq(assistantWatch.assistantChatId, source.current.id),
            eq(assistantWatch.targetProjectId, call.input.targetProjectId),
            eq(assistantWatch.targetChatId, call.input.chatId),
            isNull(assistantWatch.revokedAt),
          ),
        )
        .get();
      const intervalSeconds = call.input.intervalSeconds ?? current?.intervalSeconds ?? 300;
      if (current) {
        db.update(assistantWatch)
          .set({ intervalSeconds })
          .where(eq(assistantWatch.id, current.id))
          .run();
        rescheduleWatch({ ...current, intervalSeconds }, now);
      }
      resolveWatchIntents(source.current.id, call.input.targetProjectId, call.input.chatId, now);
      const event = captureAssistantFact(
        source.current.id,
        `watch-intent:${id()}`,
        {
          kind: "decision",
          watchIntent: !current,
          intervalSeconds,
          targetProjectId: call.input.targetProjectId,
          targetChatId: call.input.chatId,
          body: current
            ? `已更新关注间隔为 ${intervalSeconds}s；沿用原 Human 授权。`
            : `是否每 ${intervalSeconds}s 持续关注此 Chat 的工作？仅确认后生效。`,
          sampledAt: now.toISOString(),
        },
        now,
      );
      deliverAssistantEvents(now);
      return { eventId: event.id, active: !!current, intervalSeconds };
    }
    case "assistant_observe": {
      const { targetProjectId, chatId, runId: targetRunId, limit, offset } = call.input;
      if (!targetProjectId) {
        if (chatId || targetRunId) throw new AssistantError("not_found");
        return {
          projects: db
            .select({ id: project.id, name: project.name })
            .from(project)
            .where(eq(project.createdBy, userId))
            .orderBy(asc(project.id))
            .limit(limit)
            .offset(offset)
            .all(),
        };
      }
      assertProjectAccess(source.ctx, targetProjectId);
      if (targetRunId) {
        if (!chatId) throw new AssistantError("not_found");
        visibleTarget(targetProjectId, chatId, source.ctx);
        const run = db
          .select()
          .from(agentRun)
          .where(
            and(
              eq(agentRun.id, targetRunId),
              eq(agentRun.projectId, targetProjectId),
              eq(agentRun.chatId, chatId),
            ),
          )
          .get();
        if (!run) throw new AssistantError("not_found");
        return {
          run: {
            id: run.id,
            status: run.status,
            queuedAt: run.queuedAt,
            startedAt: run.startedAt,
            settledAt: run.settledAt,
            errorCode: run.errorCode,
            errorMessage: run.errorMessage,
            assistantMessageId: run.assistantMessageId,
          },
          activity: ["queued", "running"].includes(run.status)
            ? (liveActivity(run.id) ?? null)
            : run.activity,
          basis: ["queued", "running"].includes(run.status) ? "live" : "settled",
        };
      }
      if (chatId) {
        visibleTarget(targetProjectId, chatId, source.ctx);
        return {
          messages: db
            .select({
              id: message.id,
              senderKind: message.senderKind,
              senderId: message.senderId,
              body: message.body,
              createdAt: message.createdAt,
            })
            .from(message)
            .where(eq(message.chatId, chatId))
            .orderBy(desc(message.createdAt), desc(message.id))
            .limit(limit)
            .offset(offset)
            .all(),
          runs: db
            .select({ id: agentRun.id, instanceId: agentRun.instanceId, status: agentRun.status })
            .from(agentRun)
            .where(eq(agentRun.chatId, chatId))
            .orderBy(desc(agentRun.queuedAt))
            .limit(limit)
            .offset(offset)
            .all(),
        };
      }
      return {
        agents: db
          .select({
            id: agentProfile.id,
            agentProfileId: agentProfile.id,
            name: agentProfile.name,
            purpose: agentProfile.purpose,
          })
          .from(projectMember)
          .innerJoin(agentProfile, eq(agentProfile.id, projectMember.agentProfileId))
          .where(
            and(eq(projectMember.projectId, targetProjectId), eq(agentProfile.purpose, "worker")),
          )
          .orderBy(asc(agentProfile.id))
          .limit(limit)
          .offset(offset)
          .all(),
        chats: db
          .select({
            id: chat.id,
            kind: chat.kind,
            title: chat.title,
            ownerKind: chat.ownerKind,
            ownerId: chat.ownerId,
          })
          .from(chat)
          .where(eq(chat.projectId, targetProjectId))
          .orderBy(asc(chat.id))
          .limit(limit)
          .offset(offset)
          .all(),
      };
    }
  }
}
export function deliverAssistantEvents(now: Date) {
  return sqlite
    .transaction(() => {
      const pending = db
        .select()
        .from(assistantEvent)
        .where(
          and(
            isNull(assistantEvent.messageId),
            isNull(assistantEvent.suppressedAt),
            sql`(json_extract(${assistantEvent.fact}, '$.watchWindow') IS NULL OR EXISTS (
              SELECT 1 FROM ${assistantWatchSummary}
              WHERE ${assistantWatchSummary.eventId} = ${assistantEvent.id}
                AND ${assistantWatchSummary.status} IN ('completed', 'failed')
            ))`,
          ),
        )
        .orderBy(asc(assistantEvent.createdAt))
        .limit(100)
        .all();
      for (const event of pending) {
        const owner = db
          .select({ userId: project.createdBy })
          .from(chat)
          .innerJoin(project, eq(project.id, chat.projectId))
          .where(eq(chat.id, event.assistantChatId))
          .get();
        try {
          if (!owner) throw new AssistantError("not_found");
          const ctx = { userId: owner.userId, requestId: "assistant-delivery" };
          assistantSource(event.assistantChatId, ctx);
          if (event.fact.watchIntent && event.decisionResolvedAt)
            throw new AssistantError("not_found");
          visibleTarget(event.fact.targetProjectId, event.fact.targetChatId, ctx);
          if (
            event.fact.runId &&
            !hasCurrentAssistantInterest(event.assistantChatId, event.fact.runId)
          )
            throw new AssistantError("not_found");
          if (
            event.fact.watchId &&
            !db
              .select()
              .from(assistantWatch)
              .where(
                and(
                  eq(assistantWatch.id, event.fact.watchId),
                  eq(assistantWatch.assistantChatId, event.assistantChatId),
                  eq(assistantWatch.consentedBy, ctx.userId),
                  isNull(assistantWatch.revokedAt),
                ),
              )
              .get()
          )
            throw new AssistantError("not_found");
          if (event.fact.watchWindow) {
            const summary = db
              .select()
              .from(assistantWatchSummary)
              .where(eq(assistantWatchSummary.eventId, event.id))
              .get();
            if (!summary || (summary.status !== "completed" && summary.status !== "failed"))
              continue;
          }
          const messageId = id();
          db.insert(message)
            .values({
              id: messageId,
              chatId: event.assistantChatId,
              senderKind: "assistant_event",
              senderId: event.id,
              assistantEventId: event.id,
              body: event.fact.body,
              createdAt: now,
            })
            .run();
          db.update(assistantEvent)
            .set({ messageId, attempts: event.attempts + 1 })
            .where(eq(assistantEvent.id, event.id))
            .run();
          captureFeishuMessage(messageId, now);
        } catch (error) {
          if (
            error instanceof AssistantError ||
            error instanceof ProjectAccessError ||
            error instanceof ChatError
          )
            db.update(assistantEvent)
              .set({ suppressedAt: now })
              .where(eq(assistantEvent.id, event.id))
              .run();
          else throw error;
        }
      }
    })
    .immediate();
}
export function hasCurrentAssistantInterest(assistantChatId: string, runId: string) {
  return db
    .select()
    .from(assistantInterest)
    .where(
      and(
        eq(assistantInterest.assistantChatId, assistantChatId),
        eq(assistantInterest.runId, runId),
      ),
    )
    .all()
    .some((interest: typeof assistantInterest.$inferSelect) =>
      interest.originKind === "watch"
        ? !!db
            .select()
            .from(assistantWatch)
            .where(and(eq(assistantWatch.id, interest.originId), isNull(assistantWatch.revokedAt)))
            .get()
        : !!db
            .select()
            .from(assistantProposal)
            .where(
              and(
                eq(assistantProposal.id, interest.originId),
                eq(assistantProposal.status, "submitted"),
              ),
            )
            .get(),
    );
}
function targetLabel(chatId: string) {
  const target = db.select().from(chat).where(eq(chat.id, chatId)).get()!;
  if (target.kind === "public_channel") return PUBLIC_CHANNEL_DISPLAY_TITLE;
  if (target.title) return target.title;
  return (
    db
      .select({ name: agentProfile.name })
      .from(chatEffectiveMember)
      .innerJoin(agentProfile, eq(agentProfile.id, chatEffectiveMember.memberId))
      .where(
        and(eq(chatEffectiveMember.chatId, chatId), eq(chatEffectiveMember.memberKind, "agent")),
      )
      .get()?.name ?? "工作对话"
  );
}
export function assistantPanel(
  assistantChatId: string,
  ctx: ProjectContext,
  now = new Date(),
): {
  proposals: (typeof assistantProposal.$inferSelect & {
    targetLabel: string;
    agentName: string;
    expired: boolean;
  })[];
  decisions: (typeof assistantEvent.$inferSelect & { targetLabel: string })[];
  watches: (typeof assistantWatch.$inferSelect & {
    targetLabel: string;
    targetKind: "dm" | "group" | "public_channel";
    targetProjectName: string;
  })[];
  intervalSeconds: number;
} {
  assistantSource(assistantChatId, ctx);
  const visible = (row: { targetProjectId: string; targetChatId: string }) => {
    try {
      visibleTarget(row.targetProjectId, row.targetChatId, ctx);
      return true;
    } catch (error) {
      if (
        error instanceof AssistantError ||
        error instanceof ProjectAccessError ||
        error instanceof ChatError
      )
        return false;
      throw error;
    }
  };
  return {
    proposals: db
      .select()
      .from(assistantProposal)
      .where(eq(assistantProposal.assistantChatId, assistantChatId))
      .orderBy(desc(assistantProposal.createdAt))
      .limit(50)
      .all()
      .filter(visible)
      .map((row: typeof assistantProposal.$inferSelect) => ({
        ...row,
        expired: row.expiresAt.getTime() <= now.getTime(),
        targetLabel: targetLabel(row.targetChatId),
        agentName: db
          .select({ name: agentProfile.name })
          .from(agentProfile)
          .where(eq(agentProfile.id, row.agentProfileId))
          .get()!.name,
      })),
    decisions: db
      .select()
      .from(assistantEvent)
      .where(eq(assistantEvent.assistantChatId, assistantChatId))
      .orderBy(desc(assistantEvent.createdAt))
      .limit(50)
      .all()
      .filter(
        (e: typeof assistantEvent.$inferSelect) =>
          e.fact.kind === "decision" &&
          (!e.fact.watchIntent || !e.decisionResolvedAt) &&
          visible(e.fact),
      )
      .map((row: typeof assistantEvent.$inferSelect) => ({
        ...row,
        targetLabel: targetLabel(row.fact.targetChatId),
      })),
    watches: db
      .select()
      .from(assistantWatch)
      .where(
        and(eq(assistantWatch.assistantChatId, assistantChatId), isNull(assistantWatch.revokedAt)),
      )
      .all()
      .filter(visible)
      .map((row: typeof assistantWatch.$inferSelect) => ({
        ...row,
        targetLabel: targetLabel(row.targetChatId),
        targetKind: db.select().from(chat).where(eq(chat.id, row.targetChatId)).get()!.kind,
        targetProjectName: db
          .select()
          .from(project)
          .where(eq(project.id, row.targetProjectId))
          .get()!.name,
      })),
    intervalSeconds:
      db
        .select()
        .from(assistantPreferences)
        .where(eq(assistantPreferences.assistantChatId, assistantChatId))
        .get()?.intervalSeconds ?? 300,
  };
}
