import { eq } from "drizzle-orm";
import type { AssistantFact } from "../contracts/assistant";
import { db } from "../db";
import { agentInstance, agentProfile, agentRun, assistantProposal, chat } from "../db/schema";
import { assistantDuration, assistantTextPreview } from "../lib/assistant-display";

export function assistantEventSummary(fact: AssistantFact, eventKey: string): string {
  if (fact.watchIntent) {
    const target = db.select().from(chat).where(eq(chat.id, fact.targetChatId)).get();
    return `是否持续关注${target?.title ? `「${target.title}」` : "这个对话"}？确认后每 ${assistantDuration(fact.intervalSeconds ?? 300)}汇报进展。`;
  }
  if (fact.runId) {
    const row = db
      .select({ run: agentRun, name: agentProfile.name })
      .from(agentRun)
      .innerJoin(agentInstance, eq(agentInstance.id, agentRun.instanceId))
      .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
      .where(eq(agentRun.id, fact.runId))
      .get();
    if (!row) return "这项工作的运行记录已不可用。";
    const sampledAt = new Date(fact.sampledAt).getTime();
    const seconds = Math.max(
      0,
      Math.floor(
        (Math.min(row.run.settledAt?.getTime() ?? sampledAt, sampledAt) -
          (row.run.startedAt ?? row.run.queuedAt).getTime()) /
          1000,
      ),
    );
    const legacy = /^Run \S+ · (\w+) · 已经过 (\d+)s/.exec(fact.body);
    const status = fact.runState?.status ?? legacy?.[1] ?? row.run.status;
    const elapsed = assistantDuration(
      fact.runState?.elapsedSeconds ?? (legacy ? Number(legacy[2]) : seconds),
    );
    if (status === "queued") return `${row.name} 尚未开始处理，已等待 ${elapsed}。`;
    if (fact.kind === "completed")
      return row.run.assistantMessageId
        ? `${row.name} 已回复，用时 ${elapsed}。`
        : `${row.name} 的运行已结束，用时 ${elapsed}，但没有最终回复。`;
    if (fact.kind === "intervention")
      return row.run.status === "aborted"
        ? `${row.name} 的工作已停止。`
        : `${row.name} 暂时无法继续，需要你查看处理。`;
    const action = fact.action
      ? `当前${assistantTextPreview(fact.action.label, 60)}${fact.action.elapsedSeconds === undefined ? "" : `，已进行 ${assistantDuration(fact.action.elapsedSeconds)}`}。`
      : "";
    return `${row.name} 正在工作，已进行 ${elapsed}。${action}`;
  }
  if (fact.proposalId) {
    const proposal = db
      .select({ proposal: assistantProposal, name: agentProfile.name })
      .from(assistantProposal)
      .innerJoin(agentProfile, eq(agentProfile.id, assistantProposal.agentProfileId))
      .where(eq(assistantProposal.id, fact.proposalId))
      .get();
    if (fact.kind === "intervention") return "这项工作未能交给 Agent，请查看详情处理。";
    if (eventKey.endsWith(":confirmed"))
      return `已确认，工作已交给 ${proposal?.name ?? "Agent"}，等待处理。`;
    if (eventKey.endsWith(":rejected")) return "已拒绝这项工作。";
    if (eventKey.endsWith(":revoked")) return "已撤销尚未交给 Agent 的工作；已开始的工作会继续。";
    return `有一项交给 ${proposal?.name ?? "Agent"} 的工作等待你确认。`;
  }
  return assistantTextPreview(fact.body);
}
