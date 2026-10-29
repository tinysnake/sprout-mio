import type {
  ChatRunAggregate,
  AgentRunsView,
  ChatInfoView,
  InfoHubRunSummary,
  ProjectAgentEntry,
  ProjectInfoHub,
  TurnStartContext,
} from "../contracts/info-hub";
import type { LeaseView } from "../contracts/lease";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentInstance, agentProfile, agentRun, leaseMutation, machineLease } from "../db/schema";
import { AGENT_RUN_STATUSES, type AgentRun, type AgentRunStatus } from "../contracts/agent-run";
import type { Chat } from "../contracts/chat";
import { chatDisplayTitle } from "../contracts/chat";
import { listProjectMachines } from "./machine";
import type { MachineContext } from "./machine";
import { config } from "../lib/config";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile, listProjectMembers } from "./agent";
import { listAgentRunInputs, listAgentRuns } from "./agent-run";
import { getChat, listChatMembers, listChats, listInstancesForChat, listMessages } from "./chat";
import { getProjectRepoState, getRunRepoBasis } from "./repository";

const PERSONA_SUMMARY_LIMIT = 120;
const RECENT_RUNS_LIMIT = 5;

function personaSummary(persona: string): string {
  const trimmed = persona.trim();
  return trimmed.length <= PERSONA_SUMMARY_LIMIT
    ? trimmed
    : `${trimmed.slice(0, PERSONA_SUMMARY_LIMIT)}…`;
}

function isActive(run: AgentRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function runSummary(run: AgentRun, ctx: ProjectContext): InfoHubRunSummary {
  const pendingInputs = listAgentRunInputs(run.id, ctx).filter(
    (input) => input.disposition === "pending",
  ).length;
  const repo = getRunRepoBasis(run.id, ctx);
  return {
    runId: run.id,
    status: run.status,
    queuedAt: run.queuedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.settledAt ? { settledAt: run.settledAt } : {}),
    requestId: run.requestId,
    pendingInputs,
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    ...(run.assistantMessageId ? { assistantMessageId: run.assistantMessageId } : {}),
    ...(repo
      ? {
          repo: {
            source: repo.source,
            sourceKind: repo.sourceKind,
            ref: repo.ref,
            commit: repo.commit,
            fresh: repo.fresh,
            recordedAt: repo.recordedAt,
            ...(repo.fetchedAt ? { fetchedAt: repo.fetchedAt } : {}),
          },
        }
      : {}),
  };
}

/** run 事实来自领域查询；pending 输入只以未投递计数出现，不重新拼装状态。 */
function runsView(chats: Chat[], ctx: ProjectContext): AgentRunsView {
  const runs = chats
    .flatMap((chat) => listAgentRuns(chat.id, ctx))
    .sort((left, right) =>
      left.queuedAt === right.queuedAt ? 0 : left.queuedAt < right.queuedAt ? -1 : 1,
    );
  const recent = runs
    .filter((run) => !isActive(run))
    .slice(-RECENT_RUNS_LIMIT)
    .reverse();
  return {
    available: true,
    hostEnabled: config.SPROUT_PI_ENABLED,
    active: runs.filter(isActive).map((run) => runSummary(run, ctx)),
    recent: recent.map((run) => runSummary(run, ctx)),
  };
}

export function getProjectInfoHub(projectId: string, ctx: MachineContext): ProjectInfoHub {
  assertProjectAccess(ctx, projectId);
  const members = listProjectMembers(projectId, ctx);
  const chats = listChats(projectId, ctx);
  // DM 关联只从 DM 会话取：扇出后一个 Agent 在群与频道里也有 instance，
  // 把那些当成 DM 会让 Project → Agents 面板链到错误的会话。
  const dmLinks = chats
    .filter((chat) => chat.kind === "dm")
    .flatMap((chat) =>
      listInstancesForChat(chat.id, ctx).map((instance) => ({
        agentProfileId: instance.agentProfileId,
        chatId: chat.id,
        instanceId: instance.id,
      })),
    );
  const agents: ProjectAgentEntry[] = members.map((member) => {
    const profile = getAgentProfile(member.agentProfileId, ctx);
    const link = dmLinks.find((entry) => entry.agentProfileId === member.agentProfileId);
    return {
      agentProfileId: profile.id,
      name: profile.name,
      personaSummary: personaSummary(profile.persona),
      ...(link ? { chatId: link.chatId, instanceId: link.instanceId } : {}),
    };
  });
  return {
    projectId,
    agents: {
      agents,
      runs: runsView(chats, ctx),
    },
    chats: chatRunsView(chats, projectId),
    machines: listProjectMachines(projectId, ctx),
    leases: { available: true, items: leaseViews(projectId) },
  };
}

/** 会话聚合里的一次读事实：一个 instance 的一行，`status` 缺省表示它还没有任何 run。 */
type ChatRunRow = {
  chatId: string;
  agentProfileId: string;
  profileName: string;
  runId: string | null;
  status: AgentRunStatus | null;
  queuedAt: Date | null;
};

function chatRunRows(projectId: string): ChatRunRow[] {
  return db
    .select({
      chatId: agentInstance.chatId,
      agentProfileId: agentInstance.agentProfileId,
      profileName: agentProfile.name,
      runId: agentRun.id,
      status: agentRun.status,
      queuedAt: agentRun.queuedAt,
    })
    .from(agentInstance)
    .innerJoin(agentProfile, eq(agentProfile.id, agentInstance.agentProfileId))
    .leftJoin(agentRun, eq(agentRun.instanceId, agentInstance.id))
    .where(eq(agentInstance.projectId, projectId))
    .all();
}

/**
 * Info Hub 的 run 列表按会话聚合：每个会话给出会话 id、标题、去重 Agent 数与 run 状态分布。
 *
 * 一次查询取齐 Project 内全部 instance 及其 run（`left join`），按会话在内存里分组；不在会话
 * 循环里再逐条查库。`agentCount` 只统计真实出过 run 的 Agent：`agent_profile_id` 去重，同一 Agent
 * 的多条 run 只计 1 个。不做分页与缓存（归 P6，followups 已记）。
 */
function chatRunsView(chats: Chat[], projectId: string): ChatRunAggregate[] {
  const rows = chatRunRows(projectId);
  const facts = new Map<
    string,
    {
      agents: Set<string>;
      counts: Map<AgentRunStatus, number>;
      names: Map<string, string>;
      active: string[];
      latest?: string;
    }
  >();
  for (const row of rows) {
    const fact = facts.get(row.chatId) ?? {
      agents: new Set<string>(),
      counts: new Map<AgentRunStatus, number>(),
      names: new Map<string, string>(),
      active: [] as string[],
      latest: undefined as string | undefined,
    };
    facts.set(row.chatId, fact);
    fact.names.set(row.agentProfileId, row.profileName);
    if (row.status === null || row.queuedAt === null) continue;
    fact.agents.add(row.agentProfileId);
    fact.counts.set(row.status, (fact.counts.get(row.status) ?? 0) + 1);
    const queuedAt = row.queuedAt.toISOString();
    if (fact.latest === undefined || queuedAt > fact.latest) fact.latest = queuedAt;
    if ((row.status === "queued" || row.status === "running") && row.runId) {
      fact.active.push(row.runId);
    }
  }
  return chats.map((chat) => {
    const fact = facts.get(chat.id);
    return {
      chatId: chat.id,
      kind: chat.kind,
      displayTitle: chatDisplayTitle(chat, fact ? [...fact.names.values()] : []),
      agentCount: fact?.agents.size ?? 0,
      statusCounts: AGENT_RUN_STATUSES.filter((status) => fact?.counts.has(status)).map(
        (status) => ({ status, count: fact?.counts.get(status) ?? 0 }),
      ),
      activeRunIds: fact?.active ?? [],
      ...(fact?.latest ? { latestRunAt: fact.latest } : {}),
    };
  });
}

/**
 * 租约只读投影：按 projectId 过滤 machine_lease，pendingMutationId 来自本租约唯一的
 * pending 动作收据。只读这两张表；没有租约时 items 为空数组，不给占位原因。
 * 申请/释放属于后续单元，这里不提供任何变更。
 */
function leaseViews(projectId: string): LeaseView[] {
  const pending = db
    .select({ machineId: leaseMutation.machineId, id: leaseMutation.id })
    .from(leaseMutation)
    .where(and(eq(leaseMutation.projectId, projectId), eq(leaseMutation.state, "pending")))
    .all();
  const pendingByMachine = new Map(
    pending.map((row: { machineId: string; id: string }) => [row.machineId, row.id]),
  );
  return db
    .select()
    .from(machineLease)
    .where(eq(machineLease.projectId, projectId))
    .orderBy(machineLease.machineId)
    .all()
    .map((row: typeof machineLease.$inferSelect) => ({
      projectId: row.projectId,
      machineId: row.machineId,
      generation: row.generation,
      state: row.state,
      holderInstanceId: row.holderInstanceId,
      changedAt: row.changedAt.toISOString(),
      pendingMutationId: pendingByMachine.get(row.machineId) ?? null,
    }));
}

/** Chat → 自身与成员视角：授权经 chat 自带的 projectId，越权与不存在同样抛 not_found。 */
export function getChatInfo(chatId: string, ctx: ProjectContext): ChatInfoView {
  const chat = getChat(chatId, ctx);
  const members = listChatMembers(chatId, ctx);
  const instances = listInstancesForChat(chatId, ctx);
  const messages = listMessages(chatId, ctx);
  const latest = messages.at(-1);
  return {
    chatId: chat.id,
    projectId: chat.projectId,
    kind: chat.kind,
    archived: chat.archivedAt !== undefined,
    members: members.map((member) => ({
      memberKind: member.memberKind,
      memberId: member.memberId,
      displayName:
        member.memberKind === "human" ? "Human" : getAgentProfile(member.memberId, ctx).name,
    })),
    owner: chat.owner,
    instances: instances.map((instance) => ({
      instanceId: instance.id,
      agentProfileId: instance.agentProfileId,
      profileName: getAgentProfile(instance.agentProfileId, ctx).name,
    })),
    messages: {
      count: messages.length,
      ...(latest ? { latestAt: latest.createdAt } : {}),
    },
    runs: runsView([chat], ctx),
  };
}

/**
 * 轮初必要上下文：这个分身在这一轮开始时需要知道什么。
 * 不注入模型 prompt（见 contracts 的 `injectedIntoPrompt`）；只供人与后续 P6 查询消费。
 */
export function getTurnStartContext(chatId: string, ctx: ProjectContext): TurnStartContext {
  const chat = getChat(chatId, ctx);
  const instance = listInstancesForChat(chatId, ctx).at(0);
  const profile = instance ? getAgentProfile(instance.agentProfileId, ctx) : undefined;
  const runs = listAgentRuns(chatId, ctx);
  const active = runs.find(isActive);
  const activeInputs = active ? listAgentRunInputs(active.id, ctx) : [];
  const previous = runs.filter((run) => !isActive(run)).at(-1);

  const activeBasis = active ? getRunRepoBasis(active.id, ctx) : undefined;
  const checkout = getProjectRepoState(chat.projectId, ctx).checkout;
  const workspace = activeBasis
    ? {
        basis: "run_provenance" as const,
        path: activeBasis.path,
        source: activeBasis.source,
        sourceKind: activeBasis.sourceKind,
        ref: activeBasis.ref,
        commit: activeBasis.commit,
        fresh: activeBasis.fresh,
        recordedAt: activeBasis.recordedAt,
        ...(activeBasis.fetchedAt ? { fetchedAt: activeBasis.fetchedAt } : {}),
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

  return {
    projectId: chat.projectId,
    chatId: chat.id,
    instanceId: instance?.id ?? null,
    agentProfileId: profile?.id ?? null,
    profileName: profile?.name ?? null,
    hostEnabled: config.SPROUT_PI_ENABLED,
    workspace,
    activeRun: active
      ? {
          runId: active.id,
          status: active.status,
          pendingInputs: activeInputs.filter((input) => input.disposition === "pending").length,
        }
      : null,
    previousRun: previous
      ? {
          runId: previous.id,
          status: previous.status,
          requestId: previous.requestId,
          ...(previous.settledAt ? { settledAt: previous.settledAt } : {}),
          ...(previous.errorCode ? { errorCode: previous.errorCode } : {}),
          ...(previous.errorMessage ? { errorMessage: previous.errorMessage } : {}),
        }
      : null,
    injectedIntoPrompt: false,
  };
}
