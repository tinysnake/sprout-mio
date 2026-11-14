import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "../db";
import { agentProfile, chat, delegation, delegationDelivery } from "../db/schema";
import type { CrewDelegationCard, CrewDelegationRail } from "../contracts/delegation";
import type { ProjectContext } from "./access";
import { getChat } from "./chat";
import { DelegationError } from "./delegation";

export function groupCrewDelegations(cards: CrewDelegationCard[]): CrewDelegationRail {
  const active = cards.filter(
    (card) =>
      card.status === "queued" || card.status === "running" || card.status === "canceling",
  );
  const needsYou = cards.filter(
    (card) =>
      card.status === "blocked" || card.status === "failed" || card.attentionReason !== null,
  );
  const attention = new Set(needsYou.map((card) => card.delegationId));
  const completed = cards.filter(
    (card) => card.status === "completed" && !attention.has(card.delegationId),
  );
  const running = active.filter((card) => !attention.has(card.delegationId));
  return {
    active: running,
    needsYou,
    completed: completed.slice(0, 20),
    counts: { active: running.length, needsYou: needsYou.length, completed: completed.length },
  };
}

export function listCrewDelegationRail(
  input: { projectId: string; crewChatId: string },
  ctx: ProjectContext,
  now: () => number = Date.now,
): CrewDelegationRail {
  const crew = getChat(input.crewChatId, ctx);
  if (crew.kind !== "crew" || crew.projectId !== input.projectId)
    throw new DelegationError("not_found", "Crew 不存在");
  const epoch = db.select({ epoch: chat.crewEpoch }).from(chat).where(eq(chat.id, crew.id)).get()!;
  // Explicit projection keeps result bodies and request payloads out of the main-chat response.
  const rows: {
    delegationId: string;
    childChatId: string;
    workerProfileName: string;
    request: string;
    title: string | null;
    status: CrewDelegationCard["status"];
    updatedAt: Date;
    startedAt: Date | null;
    createdAt: Date;
    settledAt: Date | null;
    summary: string | null;
  }[] = db
    .select({
      delegationId: delegation.id,
      childChatId: delegation.childChatId,
      workerProfileName: agentProfile.name,
      request: delegation.requestSummary,
      title: chat.title,
      status: delegation.status,
      updatedAt: delegation.updatedAt,
      startedAt: delegation.startedAt,
      createdAt: delegation.createdAt,
      settledAt: delegation.settledAt,
      summary: delegation.terminalSummary,
    })
    .from(delegation)
    .innerJoin(chat, and(eq(chat.id, delegation.childChatId), isNull(chat.archivedAt)))
    .innerJoin(agentProfile, eq(agentProfile.id, delegation.workerProfileId))
    .where(
      and(
        eq(delegation.projectId, input.projectId),
        eq(delegation.parentCrewChatId, input.crewChatId),
        eq(delegation.crewEpoch, epoch.epoch),
        notInArray(delegation.status, ["canceled"]),
      ),
    )
    .orderBy(desc(delegation.updatedAt), desc(delegation.id))
    .all();
  const attention = db
    .select({ id: delegationDelivery.delegationId, reason: delegationDelivery.attentionReason })
    .from(delegationDelivery)
    .innerJoin(delegation, eq(delegation.id, delegationDelivery.delegationId))
    .where(
      and(
        eq(delegation.parentCrewChatId, input.crewChatId),
        eq(delegationDelivery.crewEpoch, epoch.epoch),
        eq(delegationDelivery.state, "attention"),
      ),
    )
    .orderBy(desc(delegationDelivery.updatedAt))
    .all();
  const reasons = new Map<string, string>();
  for (const item of attention)
    if (!reasons.has(item.id)) reasons.set(item.id, item.reason ?? "结果投递需要介入");
  return groupCrewDelegations(
    rows.map((row) => ({
      delegationId: row.delegationId,
      childChatId: row.childChatId,
      workerProfileName: row.workerProfileName,
      title: (row.title && row.title !== `委派给 ${row.workerProfileName}`
        ? row.title
        : row.request
      )
        .split(/\r?\n/)[0]
        .slice(0, 160),
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      elapsedMs: Math.max(
        0,
        (row.settledAt?.getTime() ?? now()) - (row.startedAt ?? row.createdAt).getTime(),
      ),
      summary: row.summary?.split(/\r?\n/)[0].slice(0, 240) ?? null,
      attentionReason:
        reasons.get(row.delegationId) ??
        (row.status === "blocked"
          ? (row.summary ?? "等待输入")
          : row.status === "failed"
            ? (row.summary ?? "执行失败")
            : null),
    })),
  );
}
