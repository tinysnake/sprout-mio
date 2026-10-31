import { agentInfoViewSchema } from "../../../contracts/info-hub-query";
import {
  chatInfoViewSchema,
  projectInfoHubSchema,
  turnStartContextSchema,
  infoHubMachineSummarySchema,
} from "../../../contracts/info-hub";

export const projectId = "prj_11111111-1111-4111-8111-111111111111";
const chatId = "cnv_22222222-2222-4222-8222-222222222222";
const agentProfileId = "agp_33333333-3333-4333-8333-333333333333";
const instanceId = "ins_44444444-4444-4444-8444-444444444444";
const machineId = "mch_55555555-5555-4555-8555-555555555555";
const runId = "run_66666666-6666-4666-8666-666666666666";
const now = "2026-06-18T02:28:00.000Z";
const runs = { available: true, hostEnabled: true, active: [], recent: [] } as const;
const counts = { proposed: 1, assigned: 0, finished: 0, canceled: 0 };
const agent = {
  agentProfileId,
  name: "Mio",
  status: "running",
  error: null,
  instanceId,
  chatId,
} as const;
export const machineFixture = infoHubMachineSummarySchema.parse({
  projectId,
  machineId,
  name: "Studio Mac",
  description: "",
  projectMembership: "current",
  connection: { kind: "unknown" },
  lease: {
    projectId,
    machineId,
    generation: 1,
    state: "held",
    holderInstanceId: instanceId,
    changedAt: now,
    pendingMutationId: null,
    holderResolution: "resolved",
    holder: {
      instanceId,
      agentProfileId,
      displayName: "Mio",
      chatId,
      chatDisplayTitle: "项目协作",
      chatKind: "group",
    },
  },
});
export const projectFixture = projectInfoHubSchema.parse({
  projectId,
  projectName: "Sprout",
  tasks: { available: true, items: [], counts },
  agents: { agents: [agent], runs },
  chats: [
    {
      chatId,
      kind: "group",
      displayTitle: "项目协作",
      agentCount: 0,
      statusCounts: [],
      activeRunIds: [],
      taskCounts: counts,
      assignedTaskIds: [],
      archived: false,
      owner: { kind: "human", id: "usr_fixture" },
      memberCount: 2,
    },
  ],
  machines: [machineFixture],
  leases: { available: true, items: [machineFixture.lease] },
});
export const chatFixture = chatInfoViewSchema.parse({
  chatId,
  projectId,
  kind: "group",
  archived: false,
  owner: { kind: "human", id: "usr_fixture" },
  members: [
    {
      memberKind: "agent",
      memberId: agentProfileId,
      displayName: "Mio",
      status: "running",
      error: null,
    },
  ],
  instances: [{ instanceId, agentProfileId, profileName: "Mio", leases: [machineFixture.lease] }],
  messages: { count: 0 },
  runs,
  tasks: { available: true, items: [] },
});
export const agentFixture = agentInfoViewSchema.parse({
  projectId,
  agent,
  runs,
  instances: [
    {
      instanceId,
      agentProfileId,
      chatId,
      chatDisplayTitle: "项目协作",
      chatKind: "group",
      leases: [machineFixture.lease],
    },
  ],
});
export const contextFixture = turnStartContextSchema.parse({
  schemaVersion: 1,
  runId,
  capturedAt: now,
  basisRevision: "fixture-1",
  serializedText: "Fixture context",
  contentHash: "f230f41fae8d8570e091f81c227eb847fb7226855809808b9e1801c06b35c90d",
  deliveryState: "prepared",
  submittedAt: null,
  failureCode: null,
  truncated: false,
  omittedCounts: { members: 0, runs: 0, tasks: 0, leases: 0, pendingLeaseRequests: 0 },
  projectId,
  chatId,
  instanceId,
  agentProfileId,
  profileName: "Mio",
  projectName: "Sprout",
  chatTitle: "项目协作",
  chatKind: "group",
  chatArchived: false,
  owner: chatFixture.owner,
  members: chatFixture.members,
  status: "running",
  heldMachines: [machineFixture],
  pendingLeaseRequests: [],
  taskCounts: counts,
  projectSummary: { agentCount: 1, chatCount: 1, machineCount: 1 },
  chatRuns: [{ runId, chatId, instanceId, agentProfileId, status: "running", isSelf: true }],
  tasks: [],
  hostEnabled: true,
  workspace: null,
  activeRun: { runId, status: "running", pendingInputs: 0 },
  injectedIntoPrompt: false,
});
