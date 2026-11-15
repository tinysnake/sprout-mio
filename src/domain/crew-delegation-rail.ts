import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { agentProfile, agentRun, chat, delegation, delegationDelivery } from "../db/schema";
import type {
  CrewDelegationActivity,
  CrewDelegationCard,
  CrewDelegationRail,
} from "../contracts/delegation";
import type { RunActivity } from "../contracts/agent-run";
import type { ProjectContext } from "./access";
import { getChat } from "./chat";
import { DelegationError } from "./delegation";

export function groupCrewDelegations(cards: CrewDelegationCard[]): CrewDelegationRail {
  const active = cards.filter((card) => card.status === "queued" || card.status === "running");
  const inactive = cards.filter((card) => !active.includes(card));
  const needsYou = inactive.filter(
    (card) =>
      card.status === "blocked" || card.status === "failed" || card.attentionReason !== null,
  );
  return {
    active,
    inactive,
    counts: { active: active.length, inactive: inactive.length, needsYou: needsYou.length },
  };
}

const INACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function cardActivity(activity: RunActivity | null): CrewDelegationActivity | null {
  const step = activity?.current ?? activity?.entries[0];
  if (!step) return null;
  return { label: step.label, detail: step.detail ?? null, status: step.status };
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
  const childChatIds = [...new Set(rows.map((row) => row.childChatId))];
  const runRows =
    childChatIds.length === 0
      ? []
      : db
          .select({ id: agentRun.id, chatId: agentRun.chatId, activity: agentRun.activity })
          .from(agentRun)
          .where(inArray(agentRun.chatId, childChatIds))
          .orderBy(desc(agentRun.queuedAt), desc(agentRun.id))
          .all();
  const latestRuns = new Map<string, (typeof runRows)[number]>();
  for (const run of runRows) if (!latestRuns.has(run.chatId)) latestRuns.set(run.chatId, run);
  const cutoff = now() - INACTIVE_WINDOW_MS;
  return groupCrewDelegations(
    rows
      .filter(
        (row) =>
          row.status === "queued" || row.status === "running" || row.updatedAt.getTime() >= cutoff,
      )
      .map((row) => {
        const run = latestRuns.get(row.childChatId);
        return {
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
          activity: cardActivity(run?.activity ?? null),
          runId: run?.id ?? null,
        };
      }),
  );
}
