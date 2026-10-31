import { describe, expect, it } from "vite-plus/test";
import {
  INFO_HUB_LIMITS,
  INFO_HUB_POLLING,
  agentRunsViewSchema,
  chatInfoViewSchema,
  chatMemberEntrySchema,
  infoHubChatSummarySchema,
  infoHubLeaseSummarySchema,
  infoHubMachineSummarySchema,
  projectAgentEntrySchema,
  projectInfoHubSchema,
  turnStartContextSchema,
} from "../src/contracts/info-hub";
import {
  agentInfoViewSchema,
  infoHubCursorValidationSchema,
  infoHubGetInputSchema,
  infoHubQuerySchema,
  infoHubRefreshInputSchema,
  infoHubRefreshResultSchema,
  infoHubToolInputSchemas,
  infoHubViewSchema,
  machineInfoViewSchema,
} from "../src/contracts/info-hub-query";
import { infoHubHintSchema } from "../src/contracts/info-hub-hint";
import {
  INFO_HUB_CAPABILITIES,
  INFO_HUB_ERROR_CODES,
} from "../src/contracts/info-hub-capabilities";
import {
  turnContextReadResultSchema,
  turnContextPromptInputSchema,
  turnContextSubmittedEventSchema,
  turnContextReadInputSchema,
  turnContextConfirmedSubmissionSchema,
  turnContextRecordSchema,
  turnContextSubmissionReceiptSchema,
} from "../src/contracts/turn-context";
import { remoteAgentRequestSchema, infoHubGetResponseSchema } from "../src/contracts/remote";
import { APP_ERROR_CODES } from "../src/contracts/result";

const projectId = "prj_11111111-1111-4111-8111-111111111111";
const otherProjectId = "prj_22222222-2222-4222-8222-222222222222";
const chatId = "cnv_11111111-1111-4111-8111-111111111111";
const otherChatId = "cnv_22222222-2222-4222-8222-222222222222";
const instanceId = "ins_11111111-1111-4111-8111-111111111111";
const agentProfileId = "agp_11111111-1111-4111-8111-111111111111";
const machineId = "mch_11111111-1111-4111-8111-111111111111";
const runId = "run_11111111-1111-4111-8111-111111111111";
const otherRunId = "run_22222222-2222-4222-8222-222222222222";
const at = "2026-05-01T00:00:00.000Z";
const taskCounts = { proposed: 0, assigned: 0, finished: 0, canceled: 0 };
const owner = { kind: "human", id: "human-a" };
const run = {
  runId,
  chatId,
  instanceId,
  agentProfileId,
  status: "running",
  queuedAt: at,
  requestId: "request-a",
  pendingInputs: 0,
};
const agent = {
  agentProfileId,
  name: "Builder",
  personaSummary: "契约维护者",
  status: "running",
  error: null,
};
const lease = {
  projectId,
  machineId,
  generation: 1,
  state: "held",
  holderInstanceId: instanceId,
  pendingMutationId: null,
  changedAt: at,
  holderResolution: "resolved",
  holder: {
    instanceId,
    agentProfileId,
    displayName: "Builder",
    chatId,
    chatDisplayTitle: "Work",
    chatKind: "group",
  },
};
const machine = {
  projectId,
  machineId,
  name: "Build machine",
  description: "Local build",
  projectMembership: "current",
  connection: { kind: "offline", generation: 1, lastSeenAt: at, reason: "closed" },
  lease,
};
const chat = {
  chatId,
  kind: "group",
  displayTitle: "Work",
  archived: false,
  owner,
  memberCount: 1,
  agentCount: 1,
  statusCounts: [{ status: "running", count: 1 }],
  activeRunIds: [runId],
  assignedTaskIds: [],
  taskCounts,
};
const instance = {
  instanceId,
  agentProfileId,
  chatId,
  chatDisplayTitle: "Work",
  chatKind: "group",
  leases: [lease],
};
const snapshot = {
  schemaVersion: 1,
  runId,
  capturedAt: at,
  basisRevision: "rev-a",
  serializedText: "You are Builder in Work.",
  contentHash: "a".repeat(64),
  deliveryState: "prepared",
  submittedAt: null,
  failureCode: null,
  injectedIntoPrompt: false,
  truncated: false,
  omittedCounts: { members: 0, runs: 0, tasks: 0, leases: 0, pendingLeaseRequests: 0 },
  projectId,
  chatId,
  instanceId,
  agentProfileId,
  profileName: "Builder",
  projectName: "Sprout",
  chatTitle: "Work",
  chatKind: "group",
  chatArchived: false,
  owner,
  members: [
    {
      memberKind: "agent",
      memberId: agentProfileId,
      displayName: "Builder",
      status: "running",
      error: null,
    },
  ],
  status: "running",
  heldMachines: [machine],
  pendingLeaseRequests: [],
  taskCounts,
  tasks: [],
  projectSummary: { agentCount: 1, chatCount: 1, machineCount: 1 },
  chatRuns: [{ runId, chatId, instanceId, agentProfileId, status: "running", isSelf: true }],
  hostEnabled: true,
  workspace: null,
  activeRun: { runId, status: "running", pendingInputs: 0 },
};
const hint = {
  runId,
  projectId,
  chatId,
  instanceId,
  asOf: at,
  revision: "rev-a",
  heldMachineIds: [machineId],
  changes: [
    { kind: "chat_owner", chatId },
    { kind: "machine_connection", machineId },
  ],
};
const project = {
  projectId,
  projectName: "Sprout",
  tasks: { available: true, items: [], counts: taskCounts },
  agents: {
    agents: [agent],
    runs: { available: true, hostEnabled: true, active: [run], recent: [] },
  },
  chats: [chat],
  machines: [machine],
  leases: { available: true, items: [lease] },
};
const cursor = {
  version: 1,
  projectId,
  actorScope: "grant-scope-a",
  query: { view: "project", section: "agents", limit: 25 },
  revision: "rev-a",
  sort: "stable_id_asc",
  after: agentProfileId,
};
const { after: _after, ...expectedCursor } = cursor;
const listResponse = {
  view: "project",
  section: "agents",
  projectId,
  revision: "rev-a",
  asOf: at,
  data: [agent],
  page: { total: 1, nextCursor: null },
};

describe("P6b basic projections", () => {
  it("parses Project facts while offline Machines retain held leases", () => {
    expect(projectInfoHubSchema.parse(project).machines[0]?.lease.state).toBe("held");
    expect(machineInfoViewSchema.parse(machine).connection.kind).toBe("offline");
  });

  it("parses Chat member status and actual instance-held leases", () => {
    const value = {
      chatId,
      projectId,
      kind: "group",
      archived: false,
      owner,
      members: snapshot.members,
      instances: [{ instanceId, agentProfileId, profileName: "Builder", leases: [lease] }],
      messages: { count: 0 },
      runs: project.agents.runs,
      tasks: { available: true, items: [] },
    };
    expect(chatInfoViewSchema.safeParse(value).success).toBe(true);
    expect(
      chatInfoViewSchema.safeParse({
        ...value,
        instances: [value.instances[0], value.instances[0]],
      }).success,
    ).toBe(false);
  });

  it("parses the Agent view using profile-by-Chat instances", () => {
    const value = { projectId, agent, runs: project.agents.runs, instances: [instance] };
    expect(agentInfoViewSchema.safeParse(value).success).toBe(true);
    expect(
      agentInfoViewSchema.safeParse({ ...value, instances: [instance, instance] }).success,
    ).toBe(false);
  });

  it("keeps unresolvable holders explicit without changing the held state", () => {
    const unknown = { ...lease, holder: null, holderResolution: "unknown" };
    expect(infoHubLeaseSummarySchema.parse(unknown).holderInstanceId).toBe(instanceId);
    expect(infoHubLeaseSummarySchema.safeParse({ ...unknown, state: "free" }).success).toBe(false);
    expect(
      infoHubLeaseSummarySchema.safeParse({ ...unknown, holderResolution: "none" }).success,
    ).toBe(false);
  });

  it("accepts a free lease only without a holder", () => {
    const free = {
      ...lease,
      generation: 0,
      state: "free",
      holderInstanceId: null,
      holder: null,
      holderResolution: "none",
    };
    expect(infoHubLeaseSummarySchema.safeParse(free).success).toBe(true);
    expect(infoHubLeaseSummarySchema.safeParse({ ...free, holder: lease.holder }).success).toBe(
      false,
    );
  });

  it("preserves unknown connection independently of membership and occupation", () => {
    expect(
      infoHubMachineSummarySchema.safeParse({
        ...machine,
        connection: { kind: "unknown" },
        projectMembership: "removed",
      }).success,
    ).toBe(true);
    expect(
      infoHubMachineSummarySchema.safeParse({ ...machine, projectId: otherProjectId }).success,
    ).toBe(false);
  });

  it("keeps persona and job title as separate list facts", () => {
    const parsed = projectAgentEntrySchema.parse({ ...agent, jobTitle: "Reviewer" });
    expect(parsed.personaSummary).toBe("契约维护者");
    expect(parsed.jobTitle).toBe("Reviewer");
  });

  it("requires the project-level error to identify the source run", () => {
    expect(
      projectAgentEntrySchema.safeParse({
        ...agent,
        status: "error",
        error: { runId, chatId, code: "provider_error", message: "Provider unavailable" },
      }).success,
    ).toBe(true);
    expect(projectAgentEntrySchema.safeParse({ ...agent, status: "error" }).success).toBe(false);
    expect(
      chatMemberEntrySchema.safeParse({
        ...snapshot.members[0],
        status: "idle",
        error: { runId, chatId, code: "x", message: "x" },
      }).success,
    ).toBe(false);
  });

  it.each([
    "body",
    "messages",
    "description",
    "leaseToken",
    "operationGrant",
    "taskDerivedRunState",
  ])("rejects unrelated or privileged Project fields: %s", (field) => {
    expect(projectInfoHubSchema.safeParse({ ...project, [field]: "secret" }).success).toBe(false);
  });

  it("rejects duplicated run, profile, Chat and Machine facts", () => {
    expect(
      agentRunsViewSchema.safeParse({ ...project.agents.runs, active: [run, run] }).success,
    ).toBe(false);
    expect(
      projectInfoHubSchema.safeParse({
        ...project,
        agents: { ...project.agents, agents: [agent, agent] },
      }).success,
    ).toBe(false);
    expect(projectInfoHubSchema.safeParse({ ...project, chats: [chat, chat] }).success).toBe(false);
    expect(
      projectInfoHubSchema.safeParse({ ...project, machines: [machine, machine] }).success,
    ).toBe(false);
    expect(
      infoHubChatSummarySchema.safeParse({ ...chat, activeRunIds: [runId, runId] }).success,
    ).toBe(false);
  });

  it("refuses terminal runs in the active collection without inferring Task state", () => {
    expect(
      agentRunsViewSchema.safeParse({
        ...project.agents.runs,
        active: [{ ...run, status: "completed" }],
      }).success,
    ).toBe(false);
    expect(
      projectInfoHubSchema.safeParse({
        ...project,
        tasks: { available: true, items: [], counts: { ...taskCounts, finished: 5 } },
      }).success,
    ).toBe(true);
  });

  it("rejects cross-Project lease facts and cross-Chat runs", () => {
    expect(
      projectInfoHubSchema.safeParse({
        ...project,
        leases: { available: true, items: [{ ...lease, projectId: otherProjectId }] },
      }).success,
    ).toBe(false);
    const response = {
      view: "chat",
      section: "runs",
      projectId,
      chatId,
      revision: "rev-a",
      asOf: at,
      data: [{ ...run, chatId: otherChatId }],
      page: { total: 1, nextCursor: null },
    };
    expect(infoHubViewSchema.safeParse(response).success).toBe(false);
  });
});

describe("P6b run snapshots", () => {
  it("shares the persistent record schema with the turn-start read view", () => {
    expect(turnContextRecordSchema).toBe(turnStartContextSchema);
    expect(turnContextRecordSchema.parse(snapshot).runId).toBe(runId);
    expect(turnContextReadInputSchema.parse({ projectId, runId })).toEqual({ projectId, runId });
    expect(turnContextReadInputSchema.safeParse({ projectId, chatId, instanceId }).success).toBe(
      false,
    );
    expect(
      turnContextReadResultSchema.safeParse({ kind: "not_captured", projectId, runId }).success,
    ).toBe(true);
    expect(
      turnContextPromptInputSchema.safeParse({
        runId,
        contentHash: snapshot.contentHash,
        serializedText: snapshot.serializedText,
      }).success,
    ).toBe(true);
    expect(
      turnContextSubmittedEventSchema.safeParse({
        type: "turn_context_submitted",
        runId,
        contentHash: snapshot.contentHash,
        submittedAt: at,
      }).success,
    ).toBe(true);
  });

  it("retains recorded Task states and refuses historical run results in the prompt", () => {
    const task = {
      taskId: "tsk_11111111-1111-4111-8111-111111111111",
      title: "Delivered",
      status: "finished",
      revision: 1,
    };
    expect(turnContextRecordSchema.safeParse({ ...snapshot, tasks: [task] }).success).toBe(true);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        previousRun: { runId: otherRunId, status: "completed" },
      }).success,
    ).toBe(false);
    expect(
      turnContextRecordSchema.safeParse({ ...snapshot, tasks: [{ ...task, description: "body" }] })
        .success,
    ).toBe(false);
  });

  it("requires SDK submission evidence before injectedIntoPrompt is true", () => {
    expect(
      turnContextRecordSchema.safeParse({ ...snapshot, injectedIntoPrompt: true }).success,
    ).toBe(false);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        deliveryState: "submitted",
        submittedAt: at,
        injectedIntoPrompt: true,
      }).success,
    ).toBe(true);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        deliveryState: "submitted",
        submittedAt: at,
      }).success,
    ).toBe(false);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        deliveryState: "failed",
        failureCode: "submission_failed",
      }).success,
    ).toBe(true);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        deliveryState: "failed",
        failureCode: "submission_failed",
        injectedIntoPrompt: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a snapshot guessed from another run or instance", () => {
    expect(turnContextRecordSchema.safeParse({ ...snapshot, runId: otherRunId }).success).toBe(
      false,
    );
    expect(
      turnContextRecordSchema.safeParse({ ...snapshot, chatRuns: [{ ...run, isSelf: false }] })
        .success,
    ).toBe(false);
    expect(turnContextRecordSchema.safeParse({ ...snapshot, instanceId: null }).success).toBe(
      false,
    );
  });

  it("requires a content fingerprint and a receipt keyed to the submitted run", () => {
    expect(
      turnContextRecordSchema.safeParse({ ...snapshot, contentHash: "not-a-hash" }).success,
    ).toBe(false);
    expect(
      turnContextSubmissionReceiptSchema.safeParse({
        runId,
        contentHash: snapshot.contentHash,
        submittedAt: at,
      }).success,
    ).toBe(true);
    expect(
      turnContextSubmissionReceiptSchema.safeParse({
        runId,
        contentHash: snapshot.contentHash,
        inputDeliveredAt: at,
      }).success,
    ).toBe(false);
  });

  it("rejects SDK receipts from another run or serialized prompt", () => {
    const record = {
      ...snapshot,
      deliveryState: "submitted",
      submittedAt: at,
      injectedIntoPrompt: true,
    };
    const receipt = { runId, contentHash: snapshot.contentHash, submittedAt: at };
    expect(turnContextConfirmedSubmissionSchema.safeParse({ record, receipt }).success).toBe(true);
    expect(
      turnContextConfirmedSubmissionSchema.safeParse({
        record,
        receipt: { ...receipt, runId: otherRunId },
      }).success,
    ).toBe(false);
    expect(
      turnContextConfirmedSubmissionSchema.safeParse({
        record,
        receipt: { ...receipt, contentHash: "b".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("bounds the serialized prompt by UTF-8 bytes and makes omissions explicit", () => {
    expect(
      turnContextRecordSchema.safeParse({ ...snapshot, serializedText: "界".repeat(2731) }).success,
    ).toBe(false);
    expect(turnContextRecordSchema.safeParse({ ...snapshot, truncated: true }).success).toBe(false);
    expect(
      turnContextRecordSchema.safeParse({
        ...snapshot,
        truncated: true,
        omittedCounts: { ...snapshot.omittedCounts, members: 2 },
      }).success,
    ).toBe(true);
  });
});

describe("P6b active query and Human refresh", () => {
  it.each([
    { view: "project", section: "agents" },
    { view: "chat", chatId, section: "members" },
    { view: "agent", agentProfileId, section: "instances" },
    { view: "machine", machineId },
  ])("parses the $view query without accepting actor identity", (query) => {
    expect(infoHubQuerySchema.safeParse(query).success).toBe(true);
    expect(infoHubGetInputSchema.safeParse({ ...query, projectId }).success).toBe(true);
    for (const identity of ["runId", "instanceId", "userId", "actor", "role"]) {
      expect(
        infoHubGetInputSchema.safeParse({ ...query, projectId, [identity]: "fake" }).success,
      ).toBe(false);
    }
  });

  it("registers the grant-injected v2 call and a model schema without projectId", () => {
    const input = { projectId, view: "project", section: "agents" };
    expect(
      remoteAgentRequestSchema.safeParse({ version: 2, call: { type: "info_hub_get", input } })
        .success,
    ).toBe(true);
    expect(infoHubToolInputSchemas.sprout_info_hub_get.safeParse(input).success).toBe(false);
    expect(infoHubGetResponseSchema).toBe(infoHubViewSchema);
  });

  it("applies the shared page default and refuses oversized or incomplete ranges", () => {
    expect(infoHubQuerySchema.parse({ view: "project", section: "agents" })).toMatchObject({
      limit: INFO_HUB_LIMITS.defaultPageSize,
    });
    expect(
      infoHubQuerySchema.safeParse({ view: "project", section: "agents", limit: 101 }).success,
    ).toBe(false);
    expect(infoHubQuerySchema.safeParse({ view: "project" }).success).toBe(false);
    expect(infoHubQuerySchema.safeParse({ view: "chat", chatId, section: "body" }).success).toBe(
      false,
    );
  });

  it.each(["projectId", "actorScope", "revision", "query"])(
    "rejects cursor reuse with a changed %s",
    (field) => {
      expect(
        infoHubCursorValidationSchema.safeParse({ cursor, expected: expectedCursor }).success,
      ).toBe(true);
      const changed = {
        projectId: otherProjectId,
        actorScope: "grant-scope-b",
        revision: "rev-b",
        query: { view: "project", section: "machines" },
      };
      expect(
        infoHubCursorValidationSchema.safeParse({
          cursor,
          expected: { ...expectedCursor, [field]: changed[field as keyof typeof changed] },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects duplicate rows, body data and inconsistent pagination in responses", () => {
    expect(infoHubViewSchema.safeParse(listResponse).success).toBe(true);
    expect(
      infoHubViewSchema.safeParse({
        ...listResponse,
        data: [agent, agent],
        page: { total: 2, nextCursor: null },
      }).success,
    ).toBe(false);
    expect(
      infoHubViewSchema.safeParse({ ...listResponse, data: [{ ...agent, messages: ["body"] }] })
        .success,
    ).toBe(false);
    expect(
      infoHubViewSchema.safeParse({ ...listResponse, page: { total: 0, nextCursor: null } })
        .success,
    ).toBe(false);
    expect(
      infoHubViewSchema.safeParse({
        ...listResponse,
        data: [],
        page: { total: 1, nextCursor: "next" },
      }).success,
    ).toBe(false);
  });

  it("bounds complete query responses by UTF-8 bytes", () => {
    const data = Array.from({ length: 100 }, (_, index) => ({
      ...agent,
      agentProfileId: `agp_11111111-1111-4111-8111-${index.toString().padStart(12, "0")}`,
      status: "error",
      error: { runId, chatId, code: "failed", message: "界".repeat(1000) },
    }));
    expect(
      infoHubViewSchema.safeParse({ ...listResponse, data, page: { total: 100, nextCursor: null } })
        .success,
    ).toBe(false);
  });

  it("rejects Machine and instance lease responses from another target range", () => {
    const base = { projectId, revision: "rev-a", asOf: at, page: { total: 1, nextCursor: null } };
    expect(
      infoHubViewSchema.safeParse({
        ...base,
        view: "chat",
        section: "machines",
        chatId: otherChatId,
        data: [machine],
      }).success,
    ).toBe(false);
    expect(
      infoHubViewSchema.safeParse({
        ...base,
        view: "agent",
        section: "instances",
        agentProfileId,
        data: [{ ...instance, leases: [{ ...lease, projectId: otherProjectId }] }],
      }).success,
    ).toBe(false);
  });

  it("keeps P6a's minimal automation summary in Chat queries", () => {
    const automation = {
      mode: "enabled",
      epoch: 1,
      nextDueAt: null,
      lastDecision: null,
      attentionCode: null,
      remindedHuman: false,
    };
    expect(
      infoHubViewSchema.safeParse({
        view: "chat",
        section: "summary",
        projectId,
        chatId,
        revision: "rev-a",
        asOf: at,
        data: { ...chat, automation },
      }).success,
    ).toBe(true);
    expect(
      infoHubChatSummarySchema.safeParse({
        ...chat,
        automation: { ...automation, providerSecret: "secret" },
      }).success,
    ).toBe(false);
  });

  it("uses changed/unchanged revisions and resumes without knownRevision", () => {
    const query = { view: "project", section: "agents" };
    expect(infoHubRefreshInputSchema.safeParse({ projectId, query }).success).toBe(true);
    expect(
      infoHubRefreshResultSchema.safeParse({ kind: "changed", view: listResponse }).success,
    ).toBe(true);
    expect(
      infoHubRefreshResultSchema.safeParse({
        kind: "unchanged",
        projectId,
        query,
        revision: "rev-a",
        asOf: at,
      }).success,
    ).toBe(true);
    expect(INFO_HUB_POLLING).toMatchObject({
      intervalMs: 3000,
      maxBackoffMs: 30000,
      maxInFlight: 1,
      pauseWhenHidden: true,
      fullRefreshOnResume: true,
      refreshImmediatelyOnVisible: true,
    });
  });

  it("reserves internal capture/delivery and Human-only snapshot reads", () => {
    expect(INFO_HUB_CAPABILITIES["basic.read"]).toEqual({ human: "project", agent: "project" });
    expect(INFO_HUB_CAPABILITIES["turn_snapshot.read"]).toEqual({
      human: "project",
      agent: "never",
    });
    expect(INFO_HUB_CAPABILITIES["hint.deliver"]).toEqual({ human: "never", agent: "never" });
    expect(INFO_HUB_ERROR_CODES.every((code) => APP_ERROR_CODES.includes(code))).toBe(true);
  });
});

describe("P6b ephemeral run hints", () => {
  it("accepts only the current Chat and held Machine changes", () => {
    expect(infoHubHintSchema.safeParse(hint).success).toBe(true);
    expect(
      infoHubHintSchema.safeParse({
        ...hint,
        changes: [{ kind: "chat_owner", chatId: otherChatId }],
      }).success,
    ).toBe(false);
    expect(infoHubHintSchema.safeParse({ ...hint, heldMachineIds: [] }).success).toBe(false);
  });

  it("rejects repeated semantic changes in a merged hint", () => {
    expect(
      infoHubHintSchema.safeParse({ ...hint, changes: [hint.changes[0], hint.changes[0]] }).success,
    ).toBe(false);
  });

  it.each(["retryAt", "messageId", "wakeIdleRun", "resourceNoticeId", "continuationEpoch"])(
    "cannot become a queued or durable input via %s",
    (field) => {
      expect(infoHubHintSchema.safeParse({ ...hint, [field]: "invalid" }).success).toBe(false);
    },
  );
});
