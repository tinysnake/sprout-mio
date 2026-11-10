import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  agentRun,
  assistantEvent,
  assistantWatch,
  assistantWatchSummary,
  message,
} from "../db/schema";
import type {
  ChannelActionResult,
  ChannelEnvelope,
  ChannelNativeAction,
  ChannelRoute,
} from "../contracts/channel";
import {
  assistantSource,
  assertAssistantProposalCurrent,
  confirmAssistantProposal,
  hasCurrentAssistantInterest,
  revokeAssistantProposal,
} from "./assistant";
import { rejectAssistantWatchIntent, setAssistantWatch } from "./assistant-observer";
import { getChat } from "./chat";

export class ChannelIneligible extends Error {}
export const channelHash = (value: string) => createHash("sha256").update(value).digest("hex");
const states = z.enum(["queued", "running", "completed", "failed", "aborted", "interrupted"]);
const factSchema = z.strictObject({
  kind: z.enum(["decision", "periodic", "completed", "intervention"]),
  targetProjectId: z.string().min(1),
  targetChatId: z.string().min(1),
  body: z.string(),
  sampledAt: z.iso.datetime(),
  runId: z.string().optional(),
  proposalId: z.string().optional(),
  watchId: z.string().optional(),
  watchIntent: z.boolean().optional(),
  intervalSeconds: z.number().int().min(60).max(86400).optional(),
  runState: z.strictObject({ status: states, elapsedSeconds: z.number().nonnegative() }).optional(),
  action: z
    .strictObject({ label: z.string(), elapsedSeconds: z.number().nonnegative().optional() })
    .optional(),
  digest: z
    .strictObject({
      windowStartedAt: z.string(),
      windowEndedAt: z.string(),
      messageIds: z.array(z.string()),
      runIds: z.array(z.string()),
      truncated: z.boolean(),
    })
    .optional(),
  watchWindow: z
    .strictObject({
      messages: z.array(
        z.strictObject({ id: z.string(), senderKind: z.string(), body: z.string() }),
      ),
      runs: z.array(
        z.strictObject({
          id: z.string(),
          status: states,
          error: z.string().nullable(),
          activity: z.unknown(),
        }),
      ),
    })
    .optional(),
});

function targetAccess(projectId: string, chatId: string, route: ChannelRoute) {
  const target = getChat(chatId, { userId: route.humanId, requestId: "channel-access" });
  if (target.projectId !== projectId || target.archivedAt)
    throw new ChannelIneligible("target_unavailable");
}

export function channelSourceAccess(route: ChannelRoute) {
  const source = assistantSource(route.chatId, {
    userId: route.humanId,
    requestId: "channel-source",
  });
  if (source.current.projectId !== route.projectId) throw new ChannelIneligible("source_changed");
}

export function boundedChannelText(text: string, incomplete = false): ChannelEnvelope {
  // This cap is in UTF-8 bytes, below the first adapter's payload limit. Never truncate silently.
  if (Buffer.byteLength(text, "utf8") > 12_000)
    return {
      kind: "text",
      text: "这条助理输出超过外部渠道的长度限制，未在此发送完整内容。请到 Web 查看；这条通知不表示工作已完成。",
      completeness: "oversized",
    };
  return {
    kind: "text",
    text: incomplete ? `【不完整回复：运行未正常完成】\n${text}` : text,
    completeness: incomplete ? "incomplete" : "complete",
  };
}

type Projection = { text: string; actions?: ChannelNativeAction[] };
export function projectChannelMessage(
  messageId: string,
  route: ChannelRoute,
  now: Date,
): Projection | null {
  channelSourceAccess(route);
  const row = db.select().from(message).where(eq(message.id, messageId)).get();
  if (!row || row.chatId !== route.chatId) throw new ChannelIneligible("source_changed");
  if (row.senderKind === "agent") {
    const source = assistantSource(route.chatId, {
      userId: route.humanId,
      requestId: "channel-author",
    });
    if (row.senderId !== source.profile.id) return null;
    return row.body.trim() ? { text: row.body } : null;
  }
  if (row.senderKind !== "assistant_event" || !row.assistantEventId) return null;
  const event = db
    .select()
    .from(assistantEvent)
    .where(eq(assistantEvent.id, row.assistantEventId))
    .get();
  if (!event || event.assistantChatId !== route.chatId || event.suppressedAt) return null;
  const parsed = factSchema.safeParse(event.fact);
  if (!parsed.success) return null;
  const fact = parsed.data;
  targetAccess(fact.targetProjectId, fact.targetChatId, route);
  const ctx = { userId: route.humanId, requestId: "channel-projection" };
  if (
    fact.watchId &&
    !db
      .select()
      .from(assistantWatch)
      .where(
        and(
          eq(assistantWatch.id, fact.watchId),
          eq(assistantWatch.assistantChatId, route.chatId),
          eq(assistantWatch.consentedBy, route.humanId),
          isNull(assistantWatch.revokedAt),
        ),
      )
      .get()
  )
    return null;
  if (fact.watchWindow || fact.digest) {
    if (fact.kind !== "periodic" || !fact.watchId) return null;
    const summary = db
      .select()
      .from(assistantWatchSummary)
      .where(eq(assistantWatchSummary.eventId, event.id))
      .get();
    return summary?.status === "completed" && summary.summary?.trim()
      ? { text: summary.summary }
      : null;
  }
  if (fact.watchIntent) {
    if (fact.kind !== "decision" || event.decisionResolvedAt || !fact.intervalSeconds) return null;
    return {
      text: `是否持续关注这个对话？确认后每 ${fact.intervalSeconds} 秒汇报进展。`,
      actions: (["confirm", "reject"] as const).map((action) => ({
        kind: "watch",
        eventId: event.id,
        factHash: channelHash(JSON.stringify(event.fact)),
        action,
      })),
    };
  }
  if (fact.proposalId) {
    const proposal = assertAssistantProposalCurrent(fact.proposalId, route.chatId, ctx);
    if (
      proposal.targetProjectId !== fact.targetProjectId ||
      proposal.targetChatId !== fact.targetChatId
    )
      return null;
    if (proposal.status === "pending" && proposal.expiresAt > now && fact.kind === "decision")
      return {
        text: `待确认工作：\n${proposal.body}`,
        actions: (["confirm", "reject"] as const).map((action) => ({
          kind: "proposal",
          proposalId: proposal.id,
          operationHash: proposal.operationHash,
          action,
        })),
      };
    return {
      text:
        proposal.status === "submitted"
          ? "已确认工作，等待 Agent 实际处理。"
          : proposal.status === "rejected"
            ? "已拒绝这项工作。"
            : "这项提案已失效。",
    };
  }
  if (fact.runId) {
    if (!hasCurrentAssistantInterest(route.chatId, fact.runId)) return null;
    const run = db.select().from(agentRun).where(eq(agentRun.id, fact.runId)).get();
    if (!run || run.chatId !== fact.targetChatId || run.projectId !== fact.targetProjectId)
      return null;
    if (fact.kind === "completed")
      return {
        text:
          run.status === "completed" && run.assistantMessageId
            ? "工作 Agent 已回复，请到 Web 查看完整结果。"
            : "运行已结束，但没有完整最终回复，请到 Web 查看。",
      };
    if (fact.kind === "intervention")
      return { text: "这项工作需要你查看处理，请到 Web 查看当前状态。" };
    if (fact.kind === "periodic") return { text: "工作仍在进行，请到 Web 查看当前进展。" };
  }
  return null;
}

export function assertChannelAction(
  action: ChannelNativeAction,
  route: ChannelRoute,
  now: Date,
  consumed = false,
) {
  channelSourceAccess(route);
  const ctx = { userId: route.humanId, requestId: "channel-action-access" };
  if (action.kind === "proposal") {
    const proposal = assertAssistantProposalCurrent(action.proposalId, route.chatId, ctx);
    if (
      proposal.operationHash !== action.operationHash ||
      proposal.expiresAt <= now ||
      (!consumed &&
        (action.action === "reject"
          ? proposal.status !== "pending"
          : !["pending", "submitted"].includes(proposal.status)))
    )
      throw new ChannelIneligible("proposal_changed");
    return;
  }
  const event = db.select().from(assistantEvent).where(eq(assistantEvent.id, action.eventId)).get();
  if (
    !event ||
    event.assistantChatId !== route.chatId ||
    !factSchema.safeParse(event.fact).success ||
    !event.fact.watchIntent ||
    channelHash(JSON.stringify(event.fact)) !== action.factHash
  )
    throw new ChannelIneligible("intent_changed");
  targetAccess(event.fact.targetProjectId, event.fact.targetChatId, route);
  if (!consumed && event.decisionRejectedAt && action.action !== "reject")
    throw new ChannelIneligible("intent_resolved");
}

export function executeChannelAction(
  action: ChannelNativeAction,
  route: ChannelRoute,
  now: Date,
): ChannelActionResult {
  const ctx = { userId: route.humanId, requestId: "channel-action" };
  if (action.kind === "proposal") {
    if (action.action === "confirm") {
      const result = confirmAssistantProposal(action.proposalId, route.chatId, ctx, now);
      return { kind: "proposal", status: result.status, workMessageId: result.messageId };
    }
    revokeAssistantProposal(action.proposalId, route.chatId, ctx);
    return { kind: "proposal", status: "rejected", workMessageId: null };
  }
  const event = db
    .select()
    .from(assistantEvent)
    .where(eq(assistantEvent.id, action.eventId))
    .get()!;
  if (action.action === "reject") {
    rejectAssistantWatchIntent(route.chatId, event.id, ctx, now);
    return { kind: "watch", rejected: true };
  }
  return {
    kind: "watch",
    ...setAssistantWatch(
      route.chatId,
      event.fact.targetProjectId,
      event.fact.targetChatId,
      true,
      ctx,
      now,
      event.fact.intervalSeconds,
      event.id,
    ),
  };
}
