import type {
  AgentRunsView,
  ConversationInfoView,
  InfoHubRunSummary,
  ProjectAgentEntry,
  ProjectInfoHub,
  TurnStartContext,
} from "../contracts/info-hub";
import { MACHINES_UNAVAILABLE_REASON } from "../contracts/info-hub";
import type { AgentRun } from "../contracts/agent-run";
import type { Conversation } from "../contracts/conversation";
import { config } from "../lib/config";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile, listProjectMembers } from "./agent";
import { listAgentRunInputs, listAgentRuns } from "./agent-run";
import {
  getConversation,
  listConversationMembers,
  listConversations,
  listInstancesForConversation,
  listMessages,
} from "./conversation";
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
function runsView(conversations: Conversation[], ctx: ProjectContext): AgentRunsView {
  const runs = conversations
    .flatMap((conversation) => listAgentRuns(conversation.id, ctx))
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

/** Project → Agents 视角：成员 profile、本 Project 内的 DM 与分身，run 视角为真实数据，Machine 显式不可用。 */
export function getProjectInfoHub(projectId: string, ctx: ProjectContext): ProjectInfoHub {
  assertProjectAccess(ctx, projectId);
  const members = listProjectMembers(projectId, ctx);
  const conversations = listConversations(projectId, ctx);
  const dmLinks = conversations.flatMap((conversation) =>
    listInstancesForConversation(conversation.id, ctx).map((instance) => ({
      agentProfileId: instance.agentProfileId,
      conversationId: conversation.id,
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
      ...(link ? { conversationId: link.conversationId, instanceId: link.instanceId } : {}),
    };
  });
  return {
    projectId,
    agents: {
      agents,
      runs: runsView(conversations, ctx),
    },
    machines: { available: false, reason: MACHINES_UNAVAILABLE_REASON },
  };
}

/** Conversation → 自身与成员视角：授权经 conversation 自带的 projectId，越权与不存在同样抛 not_found。 */
export function getConversationInfo(
  conversationId: string,
  ctx: ProjectContext,
): ConversationInfoView {
  const conversation = getConversation(conversationId, ctx);
  const members = listConversationMembers(conversationId, ctx);
  const instances = listInstancesForConversation(conversationId, ctx);
  const messages = listMessages(conversationId, ctx);
  const instance = instances.at(0);
  const latest = messages.at(-1);
  return {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    kind: conversation.kind,
    archived: conversation.archivedAt !== undefined,
    members: members.map((member) => ({
      memberKind: member.memberKind,
      memberId: member.memberId,
      displayName:
        member.memberKind === "human" ? "Human" : getAgentProfile(member.memberId, ctx).name,
    })),
    instance: instance
      ? {
          instanceId: instance.id,
          agentProfileId: instance.agentProfileId,
          profileName: getAgentProfile(instance.agentProfileId, ctx).name,
        }
      : null,
    messages: {
      count: messages.length,
      ...(latest ? { latestAt: latest.createdAt } : {}),
    },
    runs: runsView([conversation], ctx),
  };
}

/**
 * 轮初必要上下文：这个分身在这一轮开始时需要知道什么。
 * 不注入模型 prompt（见 contracts 的 `injectedIntoPrompt`）；只供人与后续 P6 查询消费。
 */
export function getTurnStartContext(conversationId: string, ctx: ProjectContext): TurnStartContext {
  const conversation = getConversation(conversationId, ctx);
  const instance = listInstancesForConversation(conversationId, ctx).at(0);
  const profile = instance ? getAgentProfile(instance.agentProfileId, ctx) : undefined;
  const runs = listAgentRuns(conversationId, ctx);
  const active = runs.find(isActive);
  const activeInputs = active ? listAgentRunInputs(active.id, ctx) : [];
  const previous = runs.filter((run) => !isActive(run)).at(-1);

  const activeBasis = active ? getRunRepoBasis(active.id, ctx) : undefined;
  const checkout = getProjectRepoState(conversation.projectId, ctx).checkout;
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
    projectId: conversation.projectId,
    conversationId: conversation.id,
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
