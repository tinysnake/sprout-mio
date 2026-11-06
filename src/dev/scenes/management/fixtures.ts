import type { AgentProfile, ProjectMember } from "../../../contracts/agent";
import type {
  ProjectMemberRemovalBlockedError,
  ProjectMemberRemovalOutcome,
} from "../../../contracts/project-member-removal";
import {
  projectMemberRemovalBlockedErrorSchema,
  projectMemberRemovalOutcomeSchema,
} from "../../../contracts/project-member-removal";
import type { Project } from "../../../contracts/project";
import type { ProjectProfile } from "../../../contracts/project-config";
import type { ProjectRepoState } from "../../../contracts/repository";
import type { ProjectInfoHub } from "../../../contracts/info-hub";

/**
 * 管理页场景的固定样例。全部是虚构数据，只在 src/dev 内使用；
 * 正式模块不导入这里，也不会拿它们冒充服务端结果。
 */
export const DEMO_PROJECT_ID = "prj_11111111";
export const DEMO_REQUEST_ID = "req_22222222";

export const demoProject: Project = {
  id: DEMO_PROJECT_ID,
  name: "Sprout 重构",
  description: "把协作工作台从原型推进到可交付的一期产品。",
  createdAt: "2026-10-01T02:30:00.000Z",
  updatedAt: "2026-10-18T07:12:00.000Z",
};

export const demoProfiles: AgentProfile[] = [
  {
    id: "agp_33333333",
    name: "Amenda",
    jobTitle: "全能秘书",
    persona:
      "负责整理上下文、拆解任务并盯住收口。回答先给结论，再给依据；不确定的事实必须标注来源。",
    harness: "pi",
    createdBy: "demo-human",
    createdAt: "2026-09-28T01:00:00.000Z",
    updatedAt: "2026-10-16T03:20:00.000Z",
  },
  {
    id: "agp_44444444",
    name: "Repo 分析员",
    persona: "只读仓库事实，按 commit 与文件路径说明结论，不猜测未读取的代码。",
    harness: "pi",
    createdBy: "demo-human",
    createdAt: "2026-10-02T05:10:00.000Z",
    updatedAt: "2026-10-02T05:10:00.000Z",
  },
  {
    id: "agp_55555555",
    name: "前端审阅",
    jobTitle: "视觉与可访问性",
    persona: "核对浅暗主题、宽窄屏与键盘操作，发现问题先说明影响再给改法。",
    harness: "pi",
    model: "claude-sonnet",
    effort: "high",
    createdBy: "demo-human",
    createdAt: "2026-10-05T09:00:00.000Z",
    updatedAt: "2026-10-12T11:45:00.000Z",
  },
];

export const demoMembers: ProjectMember[] = [
  {
    projectId: DEMO_PROJECT_ID,
    agentProfileId: demoProfiles[0].id,
    addedBy: "demo-human",
    addedAt: "2026-10-01T02:31:00.000Z",
  },
  {
    projectId: DEMO_PROJECT_ID,
    agentProfileId: demoProfiles[2].id,
    addedBy: "demo-human",
    addedAt: "2026-10-06T02:00:00.000Z",
  },
];

export const demoProjectProfile: ProjectProfile = {
  projectId: DEMO_PROJECT_ID,
  gitRemote: "https://example.com/sprout/mio.git",
  defaultBranch: "main",
  updatedAt: "2026-10-18T07:12:00.000Z",
};

export const demoRepoState: ProjectRepoState = {
  projectId: DEMO_PROJECT_ID,
  managedRoot: "/tmp/sprout-demo/repos",
  maxBytes: 536870912,
  checkout: {
    id: "rco_66666666",
    projectId: DEMO_PROJECT_ID,
    path: "/tmp/sprout-demo/repos/mio",
    sourceKind: "managed_clone",
    source: "https://example.com/sprout/mio.git",
    ref: "main",
    commit: "9f2c1d4b8a7e6f5d4c3b2a1908f7e6d5c4b3a291",
    fetchedAt: "2026-10-18T06:55:00.000Z",
    resolvedAt: "2026-10-18T07:00:00.000Z",
    sizeBytes: 18432000,
    status: "ready",
    updatedAt: "2026-10-18T07:00:00.000Z",
  },
};

export const demoInfoHub: ProjectInfoHub = {
  tasks: {
    available: true,
    items: [],
    counts: { proposed: 0, assigned: 0, finished: 0, canceled: 0 },
  },
  projectId: DEMO_PROJECT_ID,
  projectName: demoProject.name,
  agents: {
    agents: demoMembers.map((member, index) => ({
      agentProfileId: member.agentProfileId,
      name: demoProfiles.find((profile) => profile.id === member.agentProfileId)?.name ?? "Agent",
      personaSummary:
        demoProfiles.find((profile) => profile.id === member.agentProfileId)?.persona ?? "",
      status: "idle",
      error: null,
      ...(index === 0 ? { chatId: "cnv_77777777" } : {}),
    })),
    runs: {
      available: true,
      hostEnabled: true,
      active: [],
      recent: [
        {
          runId: "run_88888888",
          chatId: "cnv_77777777",
          instanceId: "ins_77777777",
          agentProfileId: demoMembers[0]!.agentProfileId,
          status: "completed",
          queuedAt: "2026-10-18T06:40:00.000Z",
          startedAt: "2026-10-18T06:40:05.000Z",
          settledAt: "2026-10-18T06:52:00.000Z",
          requestId: "req_99999999",
          pendingInputs: 0,
        },
      ],
    },
  },
  chats: [],
  machines: [],
  leases: { available: true, items: [] },
};

export const demoHumanName = "林澈";

/**
 * 强制移除演示场景的固定事实。全部经契约 schema 解析，保证演示数据与
 * 服务端响应同形；这里只造事实，不造状态转换。
 */
const demoBlockedRunIds = { runId: "run_aaaa1111", instanceId: "ins_aaaa1111" };
const demoBlockedChat = {
  chatId: "cnv_44444444",
  chatKind: "dm" as const,
  title: "与 Amenda 的私聊",
};
export const demoOwnerChat = {
  chatId: "cnv_55555555",
  chatKind: "group" as const,
  title: "发布协调组",
};

/** 「一次确认」入口的阻塞快照：四类责任各一组，含一个 holder 租约与一个 handoff_target 租约。 */
export function demoMemberRemovalBlockedError(
  agentProfileId: string,
): ProjectMemberRemovalBlockedError {
  return projectMemberRemovalBlockedErrorSchema.parse({
    code: "project_member_removal_blocked",
    message: "该 Agent 仍有未结责任，请先处理全部阻塞；fencing 租约请等待确认或前往租约页处理",
    requestId: DEMO_REQUEST_ID,
    details: {
      projectId: DEMO_PROJECT_ID,
      agentProfileId,
      blockers: [
        {
          kind: "active_runs",
          items: [{ ...demoBlockedRunIds, status: "running", chat: demoBlockedChat }],
        },
        {
          kind: "leases",
          items: [
            {
              key: { projectId: DEMO_PROJECT_ID, machineId: "mch_aaaa1111" },
              machineName: "Studio Mac",
              generation: 4,
              state: "held",
              holderInstanceId: demoBlockedRunIds.instanceId,
              pendingMutationId: null,
              relation: "holder",
            },
            {
              key: { projectId: DEMO_PROJECT_ID, machineId: "mch_bbbb2222" },
              machineName: "Build Box",
              generation: 2,
              state: "fencing",
              holderInstanceId: "ins_bbbb2222",
              pendingMutationId: "lmu_bbbb2222",
              relation: "handoff_target",
            },
          ],
        },
        { kind: "owner_duties", items: [{ chat: demoOwnerChat }] },
        {
          kind: "dm_assigned_tasks",
          items: [
            {
              taskId: "tsk_aaaa1111",
              title: "整理 P8 验收清单",
              status: "assigned",
              chat: demoBlockedChat,
            },
          ],
        },
      ],
    },
  });
}

/**
 * 对应的善后结果：Studio Mac 已确认撤销，Runner VM 保留为占用待处理，
 * Build Box 因不在处理范围内而保持原样（由阻塞快照推出，见结果面板）。
 */
export function demoMemberRemovalOutcome(agentProfileId: string): ProjectMemberRemovalOutcome {
  return projectMemberRemovalOutcomeSchema.parse({
    projectId: DEMO_PROJECT_ID,
    agentProfileId,
    removed: true,
    abortedRunIds: [demoBlockedRunIds.runId],
    ownerTransferredChatIds: [demoOwnerChat.chatId],
    unassignedTaskIds: ["tsk_aaaa1111"],
    leases: [
      {
        machineId: "mch_aaaa1111",
        machineName: "Studio Mac",
        outcome: "released",
        reason: null,
      },
      {
        machineId: "mch_cccc3333",
        machineName: "Runner VM",
        outcome: "retained",
        reason: "pending_dispatched_executions",
      },
    ],
  });
}

/** 重复调用（成员行已不在）的幂等空操作：没有变更，也没有可展示的善后对象。 */
export function demoMemberRemovalNoopOutcome(agentProfileId: string): ProjectMemberRemovalOutcome {
  return projectMemberRemovalOutcomeSchema.parse({
    projectId: DEMO_PROJECT_ID,
    agentProfileId,
    removed: false,
    abortedRunIds: [],
    ownerTransferredChatIds: [],
    unassignedTaskIds: [],
    leases: [],
  });
}
