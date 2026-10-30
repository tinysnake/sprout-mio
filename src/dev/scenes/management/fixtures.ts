import type { AgentProfile, ProjectMember } from "../../../contracts/agent";
import type { Project } from "../../../contracts/project";
import type { ProjectProfile } from "../../../contracts/project-config";
import type { ProjectRepoState } from "../../../contracts/repository";
import type { ProjectInfoHub } from "../../../contracts/info-hub";

/**
 * 管理页场景的固定样例。全部是虚构数据，只在 src/dev 内使用；
 * 正式模块不导入这里，也不会拿它们冒充服务端结果。
 */
export const DEMO_PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
export const DEMO_REQUEST_ID = "req_22222222-2222-4222-8222-222222222222";

export const demoProject: Project = {
  id: DEMO_PROJECT_ID,
  name: "Sprout 重构",
  description: "把协作工作台从原型推进到可交付的一期产品。",
  createdAt: "2026-10-01T02:30:00.000Z",
  updatedAt: "2026-10-18T07:12:00.000Z",
};

export const demoProfiles: AgentProfile[] = [
  {
    id: "agp_33333333-3333-4333-8333-333333333333",
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
    id: "agp_44444444-4444-4444-8444-444444444444",
    name: "Repo 分析员",
    persona: "只读仓库事实，按 commit 与文件路径说明结论，不猜测未读取的代码。",
    harness: "pi",
    createdBy: "demo-human",
    createdAt: "2026-10-02T05:10:00.000Z",
    updatedAt: "2026-10-02T05:10:00.000Z",
  },
  {
    id: "agp_55555555-5555-4555-8555-555555555555",
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
    id: "repoc_66666666-6666-4666-8666-666666666666",
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
  tasks: { available: true, items: [], counts: { proposed: 0, assigned: 0, finished: 0, canceled: 0 } },
  projectId: DEMO_PROJECT_ID,
  agents: {
    agents: demoMembers.map((member, index) => ({
      agentProfileId: member.agentProfileId,
      name: demoProfiles.find((profile) => profile.id === member.agentProfileId)?.name ?? "Agent",
      personaSummary: "负责当前 Project 的一段协作分工。",
      ...(index === 0 ? { chatId: "cnv_77777777-7777-4777-8777-777777777777" } : {}),
    })),
    runs: {
      available: true,
      hostEnabled: true,
      active: [],
      recent: [
        {
          runId: "run_88888888-8888-4888-8888-888888888888",
          status: "completed",
          queuedAt: "2026-10-18T06:40:00.000Z",
          startedAt: "2026-10-18T06:40:05.000Z",
          settledAt: "2026-10-18T06:52:00.000Z",
          requestId: "req_99999999-9999-4999-8999-999999999999",
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
