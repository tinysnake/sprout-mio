import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentInstance,
  agentProfile,
  agentRun,
  agentRunInput,
  chatEffectiveMember,
  leaseMutation,
  machine,
  machineConnection,
  machineLease,
  message,
  project,
  projectMachine,
  projectMember,
  repoProvenance,
  task,
  taskChecklistItem,
  taskEvent,
} from "../db/schema";
import { AGENT_RUN_STATUSES, type AgentRunStatus } from "../contracts/agent-run";
import {
  INFO_HUB_LIMITS,
  type AgentRunsView,
  type ChatInfoView,
  type ChatRunAggregate,
  type InfoHubAgentStatus,
  type InfoHubLeaseSummary,
  type InfoHubMachineSummary,
  type InfoHubRunSummary,
  type InfoHubTaskSummary,
  type ProjectAgentEntry,
  type ProjectInfoHub,
  type TaskCounts,
} from "../contracts/info-hub";
import {
  infoHubQuerySchema,
  infoHubViewSchema,
  infoHubCursorPayloadSchema,
  infoHubCursorValidationSchema,
  agentInfoViewSchema,
  type AgentInfoView,
  type InfoHubQuery,
  type InfoHubView,
  type InfoHubRefreshResult,
} from "../contracts/info-hub-query";
import type { LeaseView } from "../contracts/lease";
import { chatDisplayTitle, type Chat } from "../contracts/chat";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { config } from "../lib/config";
import {
  assertProjectAccess,
  ProjectAccessError,
  readRunScope,
  type ProjectContext,
} from "./access";
import type { MachineContext } from "./machine";
import { getChat, listChatMembers, listChats } from "./chat";

export class InfoHubError extends Error {
  constructor(
    readonly code:
      | "info_hub_cursor_stale"
      | "turn_context_unavailable"
      | "too_many_requests"
      | "forbidden"
      | "not_found",
    message = code,
  ) {
    super(message);
  }
}
const active = (run: { status: string }) => run.status === "queued" || run.status === "running";

/** Fixed batch reads. Only run metadata and input counts are selected, never prompt/message bodies. */
function projectRuns(projectId: string): InfoHubRunSummary[] {
  const pending: { runId: string; count: number }[] = db
    .select({ runId: agentRunInput.runId, count: sql<number>`count(*)` })
    .from(agentRunInput)
    .innerJoin(agentRun, eq(agentRun.id, agentRunInput.runId))
    .where(and(eq(agentRun.projectId, projectId), eq(agentRunInput.disposition, "pending")))
    .groupBy(agentRunInput.runId)
    .all();
  const counts = new Map(pending.map((row) => [row.runId, row.count]));
  const provenance: (typeof repoProvenance.$inferSelect)[] = db
    .select()
    .from(repoProvenance)
    .where(eq(repoProvenance.projectId, projectId))
    .all();
  const repos = new Map(provenance.map((row) => [row.runId, row]));
  return db
    .select({ run: agentRun, profileId: agentInstance.agentProfileId })
    .from(agentRun)
    .innerJoin(agentInstance, eq(agentInstance.id, agentRun.instanceId))
    .where(eq(agentRun.projectId, projectId))
    .orderBy(asc(agentRun.queuedAt), asc(agentRun.id))
    .all()
    .map(({ run, profileId }: { run: typeof agentRun.$inferSelect; profileId: string }) => {
      const repo = repos.get(run.id);
      return {
        runId: run.id,
        chatId: run.chatId,
        instanceId: run.instanceId,
        agentProfileId: profileId,
        status: run.status,
        queuedAt: run.queuedAt.toISOString(),
        requestId: run.requestId,
        pendingInputs: counts.get(run.id) ?? 0,
        ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
        ...(run.settledAt ? { settledAt: run.settledAt.toISOString() } : {}),
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
                recordedAt: repo.recordedAt.toISOString(),
                ...(repo.fetchedAt ? { fetchedAt: repo.fetchedAt.toISOString() } : {}),
              },
            }
          : {}),
      };
    });
}
function runsView(runs: InfoHubRunSummary[]): AgentRunsView {
  return {
    available: true,
    hostEnabled: config.SPROUT_PI_ENABLED,
    active: runs.filter(active),
    recent: runs
      .filter((run) => !active(run))
      .slice(-5)
      .reverse(),
  };
}
function agentState(runs: InfoHubRunSummary[]): {
  status: InfoHubAgentStatus;
  error: ProjectAgentEntry["error"];
} {
  if (runs.some(active)) return { status: "running", error: null };
  const latest = runs.at(-1);
  if (latest?.status === "failed")
    return {
      status: "error",
      error: {
        runId: latest.runId,
        chatId: latest.chatId,
        code: latest.errorCode || "run_failed",
        message: (latest.errorMessage || "Run failed").slice(0, 2000),
      },
    };
  return { status: "idle", error: null };
}
function authorize(projectId: string, ctx: ProjectContext) {
  assertProjectAccess(ctx, projectId);
  if (ctx.agent) {
    const scope = readRunScope(ctx.agent.runId);
    const member = db
      .select()
      .from(projectMember)
      .where(
        and(
          eq(projectMember.projectId, projectId),
          eq(projectMember.agentProfileId, ctx.agent.agentProfileId),
        ),
      )
      .get();
    if (
      !scope?.active ||
      scope.projectId !== projectId ||
      scope.instanceId !== ctx.agent.instanceId ||
      scope.agentProfileId !== ctx.agent.agentProfileId ||
      !member
    )
      throw new ProjectAccessError();
  }
}
export function getProjectInfoHub(
  projectId: string,
  ctx: ProjectContext & Partial<MachineContext>,
): ProjectInfoHub {
  authorize(projectId, ctx);
  const chats = listChats(projectId, ctx);
  const rows = chatRunRows(projectId);
  const runs = projectRuns(projectId);
  const aggregates = chatRunsView(chats, rows);
  const tasks = taskSummaries(projectId, chats, aggregates, rows);
  attachChatTasks(aggregates, tasks);
  const roster: (typeof chatEffectiveMember.$inferSelect)[] = db
    .select()
    .from(chatEffectiveMember)
    .where(eq(chatEffectiveMember.projectId, projectId))
    .all();
  const profiles: { profile: typeof agentProfile.$inferSelect }[] = db
    .select({ profile: agentProfile })
    .from(projectMember)
    .innerJoin(agentProfile, eq(agentProfile.id, projectMember.agentProfileId))
    .where(eq(projectMember.projectId, projectId))
    .all();
  // 成员指向一个已不存在的 profile 是坏引用：宁可整块报 not_found，
  // 也不能靠 inner join 静默少一行、把「少了一个成员」显示成正常事实。
  const memberCount = db
    .select({ count: sql<number>`count(*)` })
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId))
    .get()!.count;
  if (memberCount !== profiles.length) throw new InfoHubError("not_found");
  const agents = profiles.map(({ profile }): ProjectAgentEntry => {
    const dm = rows.find(
      (row) =>
        row.agentProfileId === profile.id &&
        chats.some((chat) => chat.id === row.chatId && chat.kind === "dm"),
    );
    return {
      agentProfileId: profile.id,
      name: profile.name,
      // 人设与职位是两件事实：P6b 之前列表只有人设，之后只有职位，这里两个都留着。
      personaSummary: profile.persona.slice(0, 600),
      ...(profile.jobTitle ? { jobTitle: profile.jobTitle } : {}),
      ...agentState(runs.filter((run) => run.agentProfileId === profile.id)),
      ...(dm ? { instanceId: dm.instanceId, chatId: dm.chatId } : {}),
    };
  });
  const summaries = aggregates.map((aggregate) => {
    const chat = chats.find((chat) => chat.id === aggregate.chatId)!;
    return {
      ...aggregate,
      archived: !!chat.archivedAt,
      owner: chat.owner,
      memberCount: roster.filter((member) => member.chatId === chat.id).length,
    };
  });
  const leases = leaseSummaries(projectId, rows, summaries);
  return {
    projectId,
    projectName: db
      .select({ name: project.name })
      .from(project)
      .where(eq(project.id, projectId))
      .get()!.name,
    agents: { agents, runs: runsView(runs) },
    chats: summaries,
    tasks: { available: true, counts: countTasks(tasks), items: tasks },
    machines: machineSummaries(projectId, leases, ctx),
    leases: { available: true, items: leases },
  };
}
/** 会话聚合里的一次读事实：一个 instance 的一行，`status` 缺省表示它还没有任何 run。 */
type ChatRunRow = {
  chatId: string;
  instanceId: string;
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
      instanceId: agentInstance.id,
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
function chatRunsView(chats: Chat[], rows: ChatRunRow[]): ChatRunAggregate[] {
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
      activeRunIds: (fact?.active ?? []).sort(),
      taskCounts: countTasks([]),
      assignedTaskIds: [],
      ...(fact?.latest ? { latestRunAt: fact.latest } : {}),
    };
  });
}

/** Fixed-size batch reads: metadata only; no record body, run state or lease is read per Task. */
function taskSummaries(
  projectId: string,
  chats: Chat[],
  aggregates: ChatRunAggregate[],
  runRows: ChatRunRow[],
  chatId?: string,
): InfoHubTaskSummary[] {
  const scope = and(eq(task.projectId, projectId), chatId ? eq(task.chatId, chatId) : undefined);
  const tasks: (Pick<InfoHubTaskSummary, "taskId" | "title" | "status" | "revision"> & {
    chatId: string | null;
    updatedAt: Date;
  })[] = db
    .select({
      taskId: task.id,
      title: task.title,
      status: task.status,
      revision: task.revision,
      chatId: task.chatId,
      updatedAt: task.updatedAt,
    })
    .from(task)
    .where(scope)
    .orderBy(desc(task.updatedAt), asc(task.id))
    .all();
  const checklist: { taskId: string; total: number; checked: number }[] = db
    .select({
      taskId: taskChecklistItem.taskId,
      total: sql<number>`count(*)`,
      checked: sql<number>`sum(${taskChecklistItem.checked})`,
    })
    .from(taskChecklistItem)
    .innerJoin(task, eq(task.id, taskChecklistItem.taskId))
    .where(and(scope, isNull(taskChecklistItem.removedAt)))
    .groupBy(taskChecklistItem.taskId)
    .all();
  const records: {
    taskId: string | null;
    messageId: string;
    seq: number | null;
    chatId: string;
  }[] = db
    .select({
      taskId: message.taskId,
      messageId: message.id,
      seq: message.taskRecordSeq,
      chatId: message.chatId,
    })
    .from(message)
    .innerJoin(task, eq(task.id, message.taskId))
    .where(scope)
    .orderBy(asc(message.taskRecordSeq))
    .all();
  const completions: { taskId: string; seq: number | null }[] = db
    .select({
      taskId: taskEvent.taskId,
      seq: taskEvent.recordSeqAtEvent,
    })
    .from(taskEvent)
    .innerJoin(task, eq(task.id, taskEvent.taskId))
    .where(
      and(
        scope,
        sql`(${taskEvent.action} = 'complete' or
      (${taskEvent.action} = 'correct' and ${taskEvent.toStatus} = 'finished'))`,
      ),
    )
    .orderBy(asc(taskEvent.seq))
    .all();
  const roster: { chatId: string; kind: "human" | "agent"; id: string }[] = db
    .select({
      chatId: chatEffectiveMember.chatId,
      kind: chatEffectiveMember.memberKind,
      id: chatEffectiveMember.memberId,
    })
    .from(chatEffectiveMember)
    .where(eq(chatEffectiveMember.projectId, projectId))
    .all();
  const profiles: { id: string; name: string }[] = db
    .select({ id: agentProfile.id, name: agentProfile.name })
    .from(projectMember)
    .innerJoin(agentProfile, eq(agentProfile.id, projectMember.agentProfileId))
    .where(eq(projectMember.projectId, projectId))
    .all();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const aggregateById = new Map(aggregates.map((aggregate) => [aggregate.chatId, aggregate]));
  const checklistById = new Map(checklist.map((item) => [item.taskId, item]));
  const recordsByTask = new Map<string, { messageId: string; seq: number; chatId: string }[]>();
  for (const record of records) {
    if (record.taskId === null || record.seq === null) continue;
    const refs = recordsByTask.get(record.taskId) ?? [];
    refs.push({ messageId: record.messageId, seq: record.seq, chatId: record.chatId });
    recordsByTask.set(record.taskId, refs);
  }
  const completionById = new Map(completions.map((event) => [event.taskId, event.seq]));
  const responsibilityByChat = new Map<string, InfoHubTaskSummary["responsibility"]>();
  for (const current of chats) {
    if (current.archivedAt) continue;
    const members = roster.filter(
      (member) =>
        member.chatId === current.id && (member.kind === "human" || profileById.has(member.id)),
    );
    const dmAgents = members.filter((member) => member.kind === "agent");
    const owner =
      current.kind === "dm"
        ? dmAgents.length === 1
          ? { kind: "agent" as const, id: dmAgents[0]!.id }
          : undefined
        : current.owner;
    // Public Channel Human membership is implicit; other Chat owners must remain members.
    if (
      !owner ||
      (current.kind !== "public_channel" &&
        !members.some((member) => member.kind === owner.kind && member.id === owner.id))
    )
      continue;
    if (owner.kind === "human") {
      responsibilityByChat.set(current.id, { kind: "human", userId: owner.id });
    } else {
      const profile = profileById.get(owner.id);
      if (profile)
        responsibilityByChat.set(current.id, {
          kind: "agent",
          agentProfileId: profile.id,
          name: profile.name,
          instanceId:
            runRows.find((row) => row.chatId === current.id && row.agentProfileId === profile.id)
              ?.instanceId ?? null,
        });
    }
  }
  return tasks.map((row) => {
    const current = row.chatId ? chatById.get(row.chatId) : undefined;
    const aggregate = row.chatId ? aggregateById.get(row.chatId) : undefined;
    const refs = recordsByTask.get(row.taskId) ?? [];
    const last = refs.at(-1);
    const previous = refs.find((ref) => ref.seq === completionById.get(row.taskId));
    const checklist = checklistById.get(row.taskId);
    const responsibility = row.chatId ? responsibilityByChat.get(row.chatId) : undefined;
    return {
      taskId: row.taskId,
      title: row.title,
      status: row.status,
      revision: row.revision,
      ...(current
        ? { chatId: current.id, chatKind: current.kind, chatDisplayTitle: aggregate!.displayTitle }
        : {}),
      ...(responsibility ? { responsibility } : {}),
      checklistTotal: checklist?.total ?? 0,
      checklistChecked: checklist?.checked ?? 0,
      recordCount: refs.length,
      ...(last ? { lastRecordRef: last } : {}),
      ...(previous ? { previousCompletionRef: previous } : {}),
      updatedAt: row.updatedAt.toISOString(),
      context: {
        activeRunIds: aggregate?.activeRunIds ?? [],
        relation: "same_chat",
        taskRunBinding: false,
      },
    };
  });
}

function countTasks(tasks: InfoHubTaskSummary[]): TaskCounts {
  const counts: TaskCounts = { proposed: 0, assigned: 0, finished: 0, canceled: 0 };
  for (const task of tasks) counts[task.status]++;
  return counts;
}

function attachChatTasks(chats: ChatRunAggregate[], tasks: InfoHubTaskSummary[]): void {
  for (const chat of chats) {
    const assigned = tasks.filter((task) => task.chatId === chat.chatId);
    chat.taskCounts = countTasks(assigned);
    chat.assignedTaskIds = assigned
      .filter((task) => task.status === "assigned")
      .map((task) => task.taskId);
  }
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

function leaseSummaries(
  projectId: string,
  rows: ChatRunRow[],
  chats: ChatRunAggregate[],
): InfoHubLeaseSummary[] {
  return leaseViews(projectId).map((lease) => {
    const instance = rows.find((row) => row.instanceId === lease.holderInstanceId);
    const chat = instance && chats.find((chat) => chat.chatId === instance.chatId);
    return {
      ...lease,
      holderResolution:
        lease.holderInstanceId === null ? "none" : instance && chat ? "resolved" : "unknown",
      holder:
        instance && chat
          ? {
              instanceId: instance.instanceId,
              agentProfileId: instance.agentProfileId,
              displayName: instance.profileName,
              chatId: instance.chatId,
              chatDisplayTitle: chat.displayTitle,
              chatKind: chat.kind,
            }
          : null,
    };
  });
}
function machineSummaries(
  projectId: string,
  leases: InfoHubLeaseSummary[],
  ctx: Partial<MachineContext>,
): InfoHubMachineSummary[] {
  const bindings: {
    binding: typeof projectMachine.$inferSelect;
    machine: typeof machine.$inferSelect;
  }[] = db
    .select({ binding: projectMachine, machine })
    .from(projectMachine)
    .innerJoin(machine, eq(machine.id, projectMachine.machineId))
    .where(eq(projectMachine.projectId, projectId))
    .all();
  const connections: { connection: typeof machineConnection.$inferSelect }[] = db
    .select({ connection: machineConnection })
    .from(machineConnection)
    .where(
      sql`${machineConnection.machineId} in (select machine_id from project_machine where project_id = ${projectId} union select machine_id from machine_lease where project_id = ${projectId})`,
    )
    .orderBy(desc(machineConnection.generation))
    .all();
  const machines: (typeof machine.$inferSelect)[] = db
    .select()
    .from(machine)
    .where(
      sql`${machine.id} in (select machine_id from machine_lease where project_id = ${projectId})`,
    )
    .all();
  const ids = new Set([
    ...bindings.map((row) => row.machine.id),
    ...leases.map((lease) => lease.machineId),
  ]);
  return [...ids].sort().flatMap((id) => {
    const binding = bindings.find((row) => row.machine.id === id);
    const item = binding?.machine ?? machines.find((row) => row.id === id);
    if (!item) return [];
    // An unacquired initial binding has generation zero, matching lease.read. Stored held/fencing always wins.
    const lease: InfoHubLeaseSummary = leases.find((lease) => lease.machineId === id) ?? {
      projectId,
      machineId: id,
      generation: 0,
      state: "free",
      holderInstanceId: null,
      changedAt: binding!.binding.createdAt.toISOString(),
      pendingMutationId: null,
      holderResolution: "none",
      holder: null,
    };
    const connection = connections.find((row) => row.connection.machineId === id)?.connection;
    const current =
      connection &&
      ctx.bootId &&
      connection.bootId === ctx.bootId &&
      connection.status === "open" &&
      (ctx.now ?? new Date()).getTime() - connection.lastSeenAt.getTime() < WORKER_STALE_AFTER_MS;
    return [
      {
        projectId,
        machineId: id,
        name: item.name,
        description: binding?.binding.description ?? "",
        projectMembership: binding ? ("current" as const) : ("removed" as const),
        lease,
        connection: !ctx.bootId
          ? { kind: "unknown" as const }
          : current
            ? {
                kind: connection.seq > 0 ? ("online" as const) : ("connecting" as const),
                generation: connection.generation,
                lastSeenAt: connection.lastSeenAt.toISOString(),
              }
            : {
                kind: "offline" as const,
                generation: connection?.generation ?? null,
                lastSeenAt: connection?.lastSeenAt.toISOString() ?? null,
                reason: !connection
                  ? ("never_connected" as const)
                  : connection.bootId !== ctx.bootId
                    ? ("host_restarted" as const)
                    : connection.status === "closed"
                      ? ("closed" as const)
                      : ("stale" as const),
              },
      },
    ];
  });
}
export function getChatInfo(chatId: string, ctx: ProjectContext): ChatInfoView {
  const chat = getChat(chatId, ctx);
  const hub = getProjectInfoHub(chat.projectId, ctx);
  const roster = listChatMembers(chatId, ctx);
  const profiles: (typeof agentProfile.$inferSelect)[] = db
    .select()
    .from(agentProfile)
    .where(
      sql`${agentProfile.id} in (select agent_profile_id from project_member where project_id = ${chat.projectId})`,
    )
    .all();
  const instances: (typeof agentInstance.$inferSelect)[] = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.chatId, chatId))
    .all();
  const stats = db
    .select({ count: sql<number>`count(*)`, latest: sql<number | null>`max(${message.createdAt})` })
    .from(message)
    .where(eq(message.chatId, chatId))
    .get()!;
  return {
    chatId,
    projectId: chat.projectId,
    kind: chat.kind,
    archived: !!chat.archivedAt,
    owner: chat.owner,
    members: roster.map((member) =>
      member.memberKind === "human"
        ? { memberKind: "human" as const, memberId: member.memberId, displayName: "Human" }
        : {
            memberKind: "agent" as const,
            memberId: member.memberId,
            displayName:
              profiles.find((profile) => profile.id === member.memberId)?.name ?? member.memberId,
            ...(() => {
              const agent = hub.agents.agents.find(
                (agent) => agent.agentProfileId === member.memberId,
              );
              return { status: agent?.status ?? ("idle" as const), error: agent?.error ?? null };
            })(),
          },
    ),
    instances: instances.map((instance) => ({
      instanceId: instance.id,
      agentProfileId: instance.agentProfileId,
      profileName:
        profiles.find((profile) => profile.id === instance.agentProfileId)?.name ??
        instance.agentProfileId,
      leases: hub.leases.items.filter((lease) => lease.holderInstanceId === instance.id),
    })),
    messages: {
      count: stats.count,
      ...(stats.latest !== null ? { latestAt: new Date(stats.latest * 1000).toISOString() } : {}),
    },
    runs: runsView(projectRuns(chat.projectId).filter((run) => run.chatId === chatId)),
    tasks: { available: true, items: hub.tasks.items.filter((task) => task.chatId === chatId) },
  };
}

/**
 * Agent 视角：同一个 Project 聚合里的 profile、status、活动/历史 run 与完整分身清单。
 *
 * 冻结的 query 联合里 `{view:"agent",section:"runs"}` 只回答活动 run，`section:"instances"`
 * 只回答分身，各自缺一块；这里用同一批投影组装 `agentInfoViewSchema`，不新增事实来源：
 * 分身清单来自 `agent_instance` 自身，不由「持有租约的分身」倒推。
 */
export function getAgentInfo(
  projectId: string,
  agentProfileId: string,
  ctx: ProjectContext,
): AgentInfoView {
  const hub = getProjectInfoHub(projectId, ctx);
  const agent = hub.agents.agents.find((entry) => entry.agentProfileId === agentProfileId);
  if (!agent) throw new InfoHubError("not_found");
  const runs = projectRuns(projectId).filter((run) => run.agentProfileId === agentProfileId);
  const instances: (typeof agentInstance.$inferSelect)[] = db
    .select()
    .from(agentInstance)
    .where(
      and(eq(agentInstance.projectId, projectId), eq(agentInstance.agentProfileId, agentProfileId)),
    )
    .all();
  return agentInfoViewSchema.parse({
    projectId,
    agent,
    runs: runsView(runs),
    instances: instances.map((instance) => {
      const chat = hub.chats.find((entry) => entry.chatId === instance.chatId);
      // 分身指向本视角看不到的 Chat 就是 scope 越界：不编一个 chatKind 填空。
      if (!chat) throw new InfoHubError("not_found");
      return {
        instanceId: instance.id,
        agentProfileId: instance.agentProfileId,
        chatId: instance.chatId,
        chatDisplayTitle: chat.displayTitle,
        chatKind: chat.kind,
        leases: hub.leases.items.filter((lease) => lease.holderInstanceId === instance.id),
      };
    }),
  });
}

const cursorSecret = randomBytes(32);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** 游标过期时间是参与判断的时间：时钟由调用参数注入，不在判断处就地读。 */
function signCursor(payload: unknown, now: () => number = Date.now): string {
  const body = Buffer.from(JSON.stringify({ expiresAt: now() + 5 * 60_000, payload })).toString(
    "base64url",
  );
  return `${body}.${createHmac("sha256", cursorSecret).update(body).digest("base64url")}`;
}
function parseCursor(cursor: string, now: () => number = Date.now): unknown {
  try {
    const [body, signature, extra] = cursor.split(".");
    const expected = createHmac("sha256", cursorSecret).update(body!).digest();
    const actual = Buffer.from(signature!, "base64url");
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const envelope: unknown = JSON.parse(Buffer.from(body!, "base64url").toString());
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("expiresAt" in envelope) ||
      typeof envelope.expiresAt !== "number" ||
      !Number.isFinite(envelope.expiresAt) ||
      envelope.expiresAt <= now() ||
      !("payload" in envelope)
    )
      throw new Error();
    return envelope.payload;
  } catch {
    throw new InfoHubError("info_hub_cursor_stale");
  }
}
/** One short SQLite read transaction owns authorization, revision, and the selected page. */
export function getInfoHub(
  projectId: string,
  rawQuery: InfoHubQuery,
  ctx: ProjectContext & Partial<MachineContext>,
): InfoHubView {
  return db.transaction(() => {
    const query = infoHubQuerySchema.parse(rawQuery);
    const hub = getProjectInfoHub(projectId, ctx);
    const actorScope = ctx.agent
      ? `agent:${ctx.agent.runId}:${ctx.agent.instanceId}`
      : `human:${ctx.userId}`;
    const base = { projectId, revision: hash(hub), asOf: new Date().toISOString() };
    let data: unknown;
    let scope: Record<string, string> = {};
    if (query.view === "machine") {
      data = hub.machines.find((machine) => machine.machineId === query.machineId);
      if (!data) throw new InfoHubError("not_found");
      return infoHubViewSchema.parse({
        ...base,
        view: "machine",
        machineId: query.machineId,
        data,
      });
    }
    const { cursor, ...range } = query;
    if (query.view === "project")
      data =
        query.section === "agents"
          ? hub.agents.agents
          : query.section === "chats"
            ? hub.chats
            : query.section === "tasks"
              ? hub.tasks.items
              : hub.machines;
    if (query.view === "chat") {
      const summary = hub.chats.find((chat) => chat.chatId === query.chatId);
      if (!summary) throw new InfoHubError("not_found");
      scope = { chatId: query.chatId };
      if (query.section === "summary") data = summary;
      else if (query.section === "members") {
        // Project membership grants these basic member/status facts even across Chats.
        const members: (typeof chatEffectiveMember.$inferSelect)[] = db
          .select()
          .from(chatEffectiveMember)
          .where(eq(chatEffectiveMember.chatId, query.chatId))
          .all();
        const runs = projectRuns(projectId);
        data = members.map((member) =>
          member.memberKind === "human"
            ? { memberKind: "human", memberId: member.memberId, displayName: "Human" }
            : {
                memberKind: "agent",
                memberId: member.memberId,
                displayName:
                  hub.agents.agents.find((agent) => agent.agentProfileId === member.memberId)
                    ?.name ?? member.memberId,
                ...agentState(runs.filter((run) => run.agentProfileId === member.memberId)),
              },
        );
      } else if (query.section === "runs")
        data = projectRuns(projectId).filter((run) => run.chatId === query.chatId && active(run));
      else if (query.section === "tasks")
        data = hub.tasks.items.filter((task) => task.chatId === query.chatId);
      else data = hub.machines.filter((machine) => machine.lease.holder?.chatId === query.chatId);
    }
    if (query.view === "agent") {
      const agent = hub.agents.agents.find(
        (agent) => agent.agentProfileId === query.agentProfileId,
      );
      if (!agent) throw new InfoHubError("not_found");
      scope = { agentProfileId: query.agentProfileId };
      if (query.section === "summary") data = agent;
      else if (query.section === "runs")
        data = projectRuns(projectId).filter(
          (run) => run.agentProfileId === query.agentProfileId && active(run),
        );
      else if (query.section === "machines")
        data = hub.machines.filter(
          (machine) => machine.lease.holder?.agentProfileId === query.agentProfileId,
        );
      else {
        const instances: (typeof agentInstance.$inferSelect)[] = db
          .select()
          .from(agentInstance)
          .where(
            and(
              eq(agentInstance.projectId, projectId),
              eq(agentInstance.agentProfileId, query.agentProfileId),
            ),
          )
          .all();
        data = instances.map((instance) => ({
          instanceId: instance.id,
          agentProfileId: instance.agentProfileId,
          chatId: instance.chatId,
          chatDisplayTitle: hub.chats.find((chat) => chat.chatId === instance.chatId)!.displayTitle,
          chatKind: hub.chats.find((chat) => chat.chatId === instance.chatId)!.kind,
          leases: hub.leases.items.filter((lease) => lease.holderInstanceId === instance.id),
        }));
      }
    }
    const envelope = { ...base, view: query.view, section: query.section, ...scope };
    if (!Array.isArray(data)) return infoHubViewSchema.parse({ ...envelope, data });
    const key = (item: Record<string, unknown>) =>
      String(
        query.section === "agents"
          ? item.agentProfileId
          : query.section === "members"
            ? `${String(item.memberKind)}:${String(item.memberId)}`
            : query.section === "runs"
              ? item.runId
              : query.section === "tasks"
                ? item.taskId
                : query.section === "machines"
                  ? item.machineId
                  : query.section === "instances"
                    ? item.instanceId
                    : item.chatId,
      );
    const sorted = (data as Record<string, unknown>[]).sort((a, b) => key(a).localeCompare(key(b)));
    let offset = 0;
    if (cursor) {
      const payload = infoHubCursorPayloadSchema.safeParse(parseCursor(cursor));
      if (
        !payload.success ||
        !infoHubCursorValidationSchema.safeParse({
          cursor: payload.data,
          expected: {
            version: 1,
            projectId,
            actorScope,
            query: range,
            revision: base.revision,
            sort: "stable_id_asc",
          },
        }).success
      )
        throw new InfoHubError("info_hub_cursor_stale");
      offset = sorted.findIndex((item) => key(item) === payload.data.after) + 1;
      if (!offset) throw new InfoHubError("info_hub_cursor_stale");
    }
    let items = sorted.slice(offset, offset + query.limit);
    for (;;) {
      const nextCursor =
        offset + items.length < sorted.length
          ? signCursor({
              version: 1,
              projectId,
              actorScope,
              query: range,
              revision: base.revision,
              sort: "stable_id_asc",
              after: key(items.at(-1)!),
            })
          : null;
      const result = { ...envelope, data: items, page: { total: sorted.length, nextCursor } };
      if (Buffer.byteLength(JSON.stringify(result)) <= INFO_HUB_LIMITS.maxResponseBytes)
        return infoHubViewSchema.parse(result);
      if (items.length <= 1) throw new InfoHubError("too_many_requests");
      items = items.slice(0, -1);
    }
  });
}
export function refreshInfoHub(
  projectId: string,
  query: InfoHubQuery,
  knownRevision: string | undefined,
  ctx: ProjectContext & Partial<MachineContext>,
): InfoHubRefreshResult {
  const view = getInfoHub(projectId, query, ctx);
  return view.revision === knownRevision
    ? { kind: "unchanged", projectId, query, revision: view.revision, asOf: view.asOf }
    : { kind: "changed", view };
}
